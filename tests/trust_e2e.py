"""Trust workflow on a disposable demo with exchange flags initially disabled."""

import base64
import os
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


BASE = os.environ.get("HWFORAI_TRUST_QA_URL", "http://127.0.0.1:3000").rstrip("/")
CHROMIUM = os.environ.get("HWFORAI_QA_CHROMIUM")
PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2LIAAAAASUVORK5CYII=")


def request(context, route, method="GET", data=None):
    response = context.request.fetch(f"{BASE}/api/v1/{route}", method=method, **({"data": data} if data is not None else {}))
    assert response.ok, (route, response.status, response.text())
    return response.json() if response.status != 204 else None


def login(context, name):
    return request(context, "auth/login", "POST", {"login": name, "password": name})["user"]


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), page.url


def exact_button(scope, label):
    return scope.get_by_role("button", name=label, exact=True)


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=["--no-sandbox"])
        admin = browser.new_context(viewport={"width": 1440, "height": 960}, accept_downloads=True)
        seller = browser.new_context(viewport={"width": 375, "height": 800}, is_mobile=True, has_touch=True)
        buyer = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        staff = login(admin, "admin")
        vendor = login(seller, "test1")
        login(buyer, "test2")
        if staff["mustChangePassword"]:
            request(admin, "auth/credentials", "PATCH", {"currentPassword": "admin", "newPassword": "Trust-browser-QA-2026!"})
        for feature in ["feature_actuality", "feature_disclosure_journal", "feature_trust_rating"]:
            request(admin, "admin/settings/" + feature, "PUT", {"value": True})

        mobile = seller.new_page()
        mobile.goto(BASE + "/account")
        expect(mobile.get_by_role("heading", name="Рейтинг участника")).to_be_visible()
        expect(mobile.get_by_text("Ответы об актуальности", exact=True)).to_be_visible()
        expect(mobile.locator(".trust-tag.trust-level-0")).to_have_text("Участник не проверен")
        no_overflow(mobile)
        mobile.locator("input[name=file]").set_input_files({"name": "карточка.pdf", "mimeType": "application/pdf", "buffer": PDF})
        exact_button(mobile, "Загрузить документ").click()
        expect(mobile.get_by_text("Документ отправлен на проверку.")).to_be_visible()
        print("PASS 375px account score and real browser document upload", flush=True)

        page = admin.new_page()
        page.goto(BASE + "/admin?section=exchange&part=verification")
        expect(page.get_by_role("heading", name="Кабинет проверки")).to_be_visible()
        with page.expect_download() as download:
            page.get_by_role("link", name="карточка.pdf", exact=True).click()
        assert download.value.suggested_filename == "карточка.pdf"
        assert download.value.path().read_bytes() == PDF
        document = page.get_by_role("listitem").filter(has_text="карточка.pdf")
        document.get_by_text("Решение по документу", exact=True).click()
        exact_button(document, "Сохранить решение").click()
        expect(page.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()
        profile = page.get_by_role("listitem").filter(has_text="test1")
        profile.get_by_text(re.compile(r"test1")).click()
        exact_button(profile, "Подтвердить проверку документов").click()
        expect(page.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()
        page.get_by_role("searchbox", name="Найти участника").fill("test1")
        exact_button(page, "Найти").click()
        expect(profile.locator("summary").first).to_contain_text("Документы проверены")
        mobile.reload()
        expect(mobile.locator(".trust-tag.trust-level-1")).to_have_text("Документы проверены")
        no_overflow(mobile)
        print("PASS desktop verification, audited file and participant level", flush=True)

        gpu = next(row for row in request(seller, "categories") if row["slug"] == "gpu")
        title = "Со склада H200 " + uuid4().hex[:8]
        listing = request(seller, "listings", "POST", {
            "categoryId": gpu["id"], "modelId": "h200-sxm", "title": title,
            "description": "Комплект оборудования на складе для проверки площадки.",
            "availability": "STOCK", "originCountry": "RU", "stockCity": "Казань",
            "paymentTerms": ["PREPAY_100"],
        })
        page.goto(BASE + "/admin?section=exchange&part=verification&userId=" + vendor["id"])
        profile = page.get_by_role("listitem").filter(has_text="test1")
        profile.get_by_text(re.compile(r"test1")).click()
        profile.get_by_label("Действие").select_option("day-codes")
        profile.get_by_label("Объявление для кода дня").select_option(listing["id"])
        profile.get_by_role("checkbox", name="Выборочная проверка за 24 часа").check()
        exact_button(profile, "Выдать код дня").click()
        expect(page.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()
        code = request(seller, "me/trust")["dayCodes"][0]["code"]
        mobile.goto(BASE + "/listings/" + listing["id"])
        expect(mobile.get_by_role("heading", name="Подтверждение наличия")).to_be_visible()
        mobile.locator("input[name=dayCode]").fill(code.lower())
        mobile.locator("input[name=file]").set_input_files({"name": "серия.png", "mimeType": "image/png", "buffer": PNG})
        exact_button(mobile, "Загрузить документ").click()
        expect(mobile.get_by_text("Документ отправлен на проверку.")).to_be_visible()
        no_overflow(mobile)
        page.reload()
        asset = page.get_by_role("listitem").filter(has_text="серия.png")
        expect(asset.get_by_text("Код дня действителен.")).to_be_visible()
        asset.get_by_text("Решение по документу", exact=True).click()
        exact_button(asset, "Сохранить решение").click()
        expect(page.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()

        interested = buyer.new_page()
        interested.goto(BASE + "/listings/" + listing["id"])
        expect(interested.get_by_text("Перед полной предоплатой проверьте", exact=False)).to_be_visible()
        expect(interested.get_by_text("Документы проверены", exact=True)).to_be_visible()
        expect(interested.get_by_text("Наличие подтверждено", exact=True)).to_be_visible()
        no_overflow(interested)
        print("PASS day proof on mobile and buyer warning without private proof file", flush=True)

        chat = request(buyer, "chats", "POST", {"listingId": listing["id"]})
        consent = request(buyer, f"chats/{chat['id']}/reveal", "PATCH", {"action": "REQUEST", "rulesAccepted": True})
        request(seller, f"chats/{chat['id']}/reveal", "PATCH", {
            "action": "ACCEPT", "requestId": consent["revealRequestId"], "rulesAccepted": True,
        })
        deal = request(buyer, "deals")["items"][0]
        interested.goto(BASE + "/deals/" + deal["id"] + "?action=agree")
        expect(interested.get_by_label("Статус сделки")).to_have_value("AGREED")
        interested.get_by_label("Сумма").fill("350000")
        interested.get_by_label("Количество").fill("1")
        interested.get_by_label("Валюта").select_option("USD")
        exact_button(interested, "Сохранить статус").click()
        expect(interested.get_by_role("heading", name="История сделки")).to_be_visible()
        expect(interested.get_by_text("Идут переговоры", exact=True)).to_be_visible()
        no_overflow(interested)
        print("PASS 390px deal handoff preselection, agreement and visible event", flush=True)

        deal_status = f"deals/{deal['id']}/status"
        request(seller, deal_status, "POST", {"status": "AGREED", "amount": 340000, "quantity": 1, "currency": "USD"})
        interested.reload()
        expect(interested.get_by_text("Условия расходятся", exact=True)).to_be_visible()
        request(seller, deal_status, "POST", {"status": "AGREED", "amount": 350000, "quantity": 1, "currency": "USD"})
        interested.reload()
        expect(interested.get_by_text("Условия согласованы", exact=True)).to_be_visible()
        for context in [seller, buyer]:
            request(context, deal_status, "POST", {"status": "EXECUTED"})
        interested.reload()
        expect(interested.locator(".trust-tag").filter(has_text=re.compile("^Сделка исполнена$"))).to_be_visible()
        history = interested.get_by_role("region", name="История сделки")
        expect(history.get_by_text("Сделка исполнена", exact=True)).to_be_visible()
        expect(history.get_by_text("Исполнение подтверждено одной из сторон", exact=True)).to_be_visible()
        page.goto(BASE + "/admin?section=exchange&part=verification")
        page.get_by_role("link", name=deal["disclosureNumber"], exact=True).click()
        expect(page.get_by_role("heading", name=deal["disclosureNumber"], exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="События раскрытия")).to_be_visible()
        no_overflow(page)
        print("PASS desktop link from verification queue opens the matching disclosure record", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
