"""Automatic matching by role and viewport on a disposable demo deployment.

Enable feature_matching on the test instance and set HWFORAI_URL and CHROMIUM_PATH.
Each run creates two offers and a request on the seeded seller and buyer accounts.
"""

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


BASE = os.getenv("HWFORAI_URL", "http://127.0.0.1:3100").rstrip("/")
TAG = f"Сценарий совпадения {uuid4().hex[:8]}"
PRIVATE = {"companyName", "email", "telegram", "principal", "principalId", "principal_id",
           "principalName", "agentFee", "agent_fee_value", "agentFeeValue"}


def api(context, method, path, data=None, status=None):
    options = {"method": method, "headers": {"Origin": BASE}}
    if data is not None:
        options["data"] = data
    response = context.request.fetch("/api/v1" + path, **options)
    if status is not None:
        assert response.status == status, (method, path, response.status, response.text())
    else:
        assert response.ok, (method, path, response.status, response.text())
    return response.json() if response.status < 300 and response.status != 204 else None


def assert_public(value):
    if isinstance(value, dict):
        assert not (value.keys() & PRIVATE), value.keys()
        for entry in value.values():
            assert_public(entry)
    if isinstance(value, list):
        for item in value:
            assert_public(item)


def check_width(page):
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), page.url


def main():
    expect.set_options(timeout=12000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"), headless=True,
                                             args=["--no-sandbox", "--disable-dev-shm-usage"])
        buyer = browser.new_context(base_url=BASE, viewport={"width": 375, "height": 812},
                                    is_mobile=True, has_touch=True)
        seller = browser.new_context(base_url=BASE, viewport={"width": 1280, "height": 900})
        guest = browser.new_context(base_url=BASE)
        features = api(guest, "GET", "/platform/features")
        assert features["feature_matching"] is True
        api(guest, "GET", "/matches", status=401)
        for context, username in ((buyer, "test2"), (seller, "test1")):
            api(context, "POST", "/auth/login", {"login": username, "password": username})
            api(context, "GET", "/admin/matches", status=403)

        category = next(row["id"] for row in api(seller, "GET", "/categories") if row["slug"] == "gpu")
        common = {"categoryId": category, "description": "Тест серверного совпадения условий двух объявлений.",
                  "modelId": "h100-sxm", "condition": "NEW", "priceMode": "FIXED", "currency": "USD",
                  "paymentMethods": ["BANK_TRANSFER"], "originScope": "COUNTRY", "originCountry": "RU"}
        sell = {**common, "availability": "ORDER", "quantity": 8, "minLot": 2, "shipDays": 0, "price": 750}
        buy = {**common, "destinationCountry": "RU", "originScope": "DOMESTIC", "quantity": 4,
               "minLot": 1, "price": 400,
               "deliveryBy": (datetime.now(timezone.utc) + timedelta(days=7)).date().isoformat()}
        api(seller, "POST", "/listings", {**sell, "title": TAG, "minLot": 9}, status=400)
        offer = api(seller, "POST", "/listings", {**sell, "title": f"{TAG} предложение"})
        another = api(seller, "POST", "/listings", {**sell, "title": f"{TAG} запасное предложение",
                                                   "price": 832, "paymentTerms": ["PREPAY_100"]})
        request = api(buyer, "POST", "/listings", {**buy, "title": f"{TAG} заявка"})
        response = api(buyer, "GET", f"/matches?status=NEW&listingId={request['id']}")
        matches = {row["counterpart"]["listing"]["id"]: row for row in response["items"]}
        full, partial = matches[offer["id"]], matches[another["id"]]
        assert full["type"] == "FULL" and full["counterpart"]["listing"]["unitPriceUsd"] == 93.75
        assert partial["type"] == "PARTIAL" and partial["mismatches"][0]["key"] == "PRICE"
        assert_public(response)
        assert api(seller, "GET", "/matches/" + full["id"])["side"] == "SELL"

        partial_path = "/matches/" + partial["id"]
        api(buyer, "POST", partial_path + "/decline", {}, status=400)
        phone = buyer.new_page()
        desktop = seller.new_page()
        errors = []
        for page in (phone, desktop):
            page.on("pageerror", lambda error: errors.append(str(error)))
        phone.goto(partial_path)
        expect(phone.get_by_role("heading", name="Совпадение", exact=True)).to_be_visible()
        expect(phone.get_by_text("Частичное совпадение", exact=True)).to_be_visible()
        if features["feature_trust_rating"] and partial["counterpart"]["trust"]["ownerLevel"] < 2:
            expect(phone.get_by_text("100 % предоплата рекомендуется", exact=False)).to_be_visible()
        check_width(phone)
        phone.get_by_role("button", name="Не подходит", exact=True).click()
        dialog = phone.get_by_role("dialog", name="Отклонить совпадение")
        reason = dialog.get_by_label("Причина")
        expect(reason).to_be_focused()
        reason.press("ArrowDown")
        expect(reason).to_have_value("Цена не подходит")
        dialog.get_by_role("button", name="Отклонить", exact=True).click()
        expect(phone.get_by_text("Цена не подходит", exact=True)).to_be_visible()
        notifications = api(seller, "GET", "/notifications")["items"]
        assert any("Цена не подходит" in item["body"] for item in notifications)
        api(seller, "PATCH", "/listings/" + another["id"], {"price": 700})
        assert api(buyer, "GET", partial_path)["status"] == "DECLINED"

        full_path = "/matches/" + full["id"]
        desktop.goto(f"/matches?listingId={offer['id']}")
        expect(desktop.get_by_text("Полное совпадение", exact=True).first).to_be_visible()
        check_width(desktop)
        desktop.locator(".match-card").filter(has_text=request["title"]).get_by_role("button", name="Написать", exact=True).click()
        desktop.wait_for_url("**/chats/*")
        chat_id = desktop.url.rsplit("/", 1)[1]
        assert api(buyer, "POST", full_path + "/chat")["chatId"] == chat_id
        assert api(buyer, "GET", full_path)["status"] == "CHAT"
        api(seller, "POST", full_path + "/decline", {"reason": "Другое"}, status=409)
        api(seller, "DELETE", "/listings/" + offer["id"])
        assert api(buyer, "GET", full_path)["status"] == "VOID"
        api(seller, "POST", "/listings/" + offer["id"] + "/restore")
        assert api(buyer, "GET", full_path)["status"] == "CHAT"
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    main()
