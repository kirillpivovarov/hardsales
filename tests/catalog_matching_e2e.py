"""Catalogue compatibility checks for buyers and sellers on disposable demo data.

Set HWFORAI_URL to the running app and CHROMIUM_PATH for system Chromium.
"""

import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from country_controls import choose_country


BASE = os.getenv("HWFORAI_URL", "http://127.0.0.1:3000").rstrip("/")
TAG = "catalogmatch" + uuid4().hex[:8]


def sign_in(page, username):
    page.goto("/login")
    page.locator('input[name="login"]').fill(username)
    page.locator('input[name="password"]').fill(username)
    with page.expect_response(lambda response: response.url.endswith("/api/v1/auth/login"), timeout=45000) as login:
        page.get_by_role("button", name="Войти", exact=True).click()
    assert login.value.ok, login.value.text()
    expect(page.locator(".listing-card").first).to_be_visible()


def create(page, name, category, **fields):
    title = f"{TAG} {name}"
    response = page.request.post("/api/v1/listings", headers={"Origin": BASE}, data={
        "title": title,
        "categoryId": category,
        "modelId": "h100-sxm",
        "description": "Проверка совместимости географических и ценовых фильтров.",
        "priceMode": "FIXED",
        "price": 500,
        **fields,
    })
    assert response.ok, response.text()
    return title


def catalog(page, **filters):
    page.goto("/catalog?" + urlencode({"q": TAG, **filters}))
    expect(page.locator(".listing-card").first).to_be_visible()


def card(page, title):
    return page.locator(".listing-card").filter(has_text=title)


def match_origin(page, category):
    future = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    common = {"deliveryBy": future, "destinationCountry": "RU"}
    flexible = create(page, "заявка с гибкой закупкой", category, originScope="ANY", **common)
    exact = create(page, "заявка на закупку из Казахстана", category, originScope="COUNTRY", originCountry="KZ", **common)
    domestic = create(page, "заявка на местную закупку", category, originScope="DOMESTIC", **common)
    return flexible, exact, domestic


def match_destination(page, category):
    common = {"availability": "ORDER", "originScope": "COUNTRY", "originCountry": "KZ"}
    flexible = create(page, "предложение с гибкой доставкой", category, **common)
    future = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    exact = create(page, "предложение с доставкой в Россию", category, destinationCountry="RU", deliveryBy=future, **common)
    other = create(page, "предложение с доставкой в Китай", category, destinationCountry="CN", currency="CNY", **common)
    return flexible, exact, other


def check_width(page):
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), page.url


def main():
    expect.set_options(timeout=12000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"), headless=True,
                                             args=["--no-sandbox", "--disable-dev-shm-usage"])
        phone = browser.new_context(base_url=BASE, viewport={"width": 320, "height": 780},
                                    is_mobile=True, has_touch=True)
        desktop = browser.new_context(base_url=BASE, viewport={"width": 1440, "height": 960})
        seller = phone.new_page()
        buyer = desktop.new_page()
        errors = []
        for page in (seller, buyer):
            page.on("pageerror", lambda error: errors.append(str(error)))
        sign_in(seller, "test1")
        sign_in(buyer, "test2")
        categories = buyer.request.get("/api/v1/categories").json()
        category = next(item["id"] for item in categories if item["slug"] == "gpu")

        flexible, exact, domestic = match_origin(buyer, category)
        catalog(seller)
        seller.get_by_role("button", name="Фильтры", exact=True).click()
        choose_country(seller, "originCountry", "KZ")
        expect(seller.locator(".listing-card")).to_have_count(2)
        expect(card(seller, exact)).to_be_visible()
        expect(card(seller, flexible)).to_be_visible()
        expect(card(seller, domestic)).to_have_count(0)
        check_width(seller)
        catalog(seller, country="KZ", originScope="COUNTRY")
        expect(card(seller, exact)).to_be_visible()
        expect(card(seller, flexible)).to_have_count(0)
        catalog(seller, country="ANY")
        expect(card(seller, flexible)).to_be_visible()
        expect(card(seller, exact)).to_have_count(0)
        check_width(seller)
        print("PASS mobile seller finds flexible buyers without weakening exact scope filters", flush=True)

        flexible, exact, other = match_destination(seller, category)
        catalog(buyer)
        buyer.get_by_text("Ещё фильтры", exact=True).click()
        choose_country(buyer, "destinationCountry", "RU")
        expect(buyer.locator(".listing-card")).to_have_count(2)
        expect(card(buyer, exact)).to_be_visible()
        expect(card(buyer, flexible)).to_be_visible()
        expect(card(buyer, other)).to_have_count(0)
        card(buyer, exact).click()
        expect(buyer.get_by_text("Предложение действительно до", exact=True)).to_be_visible()
        seller.goto(buyer.url + "/edit")
        expect(seller.get_by_label("Предложение действительно до", exact=False)).to_be_visible()
        check_width(seller)
        catalog(buyer, priceMax="1000")
        buyer.get_by_text("Ещё фильтры", exact=True).click()
        expect(buyer.locator('select[name="currency"]')).to_have_value("RUB")
        expect(card(buyer, exact)).to_be_visible()
        expect(card(buyer, other)).to_have_count(0)
        buyer.locator('select[name="currency"]').select_option("CNY")
        buyer.get_by_role("button", name="Применить цену", exact=True).click()
        expect(card(buyer, other)).to_be_visible()
        expect(card(buyer, exact)).to_have_count(0)
        check_width(buyer)
        assert not errors, errors
        print("PASS desktop buyer finds negotiable destinations and sees the currency applied to the price range", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
