"""Catalogue UI regression against a running hwforai demo instance.

Install Python playwright, then run:
  HWFORAI_URL=http://127.0.0.1:3000 python tests/catalog_ui.py
Set CHROMIUM_PATH when using a system Chromium binary.
"""
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.getenv("HWFORAI_URL", "http://127.0.0.1:3000")
CHROMIUM_PATH = os.getenv("CHROMIUM_PATH")
SCREENSHOTS = os.getenv("HWFORAI_SCREENSHOTS")


def login(page, username):
    page.locator('input[name="login"]').fill(username)
    page.locator('input[name="password"]').fill(username)
    page.locator('form button[type="submit"]').click()


def check_width(page):
    scroll_width = page.evaluate("document.documentElement.scrollWidth")
    assert scroll_width <= page.viewport_size["width"], (page.url, scroll_width)
    assert page.locator("main").count() == 1


def capture(page, filename):
    if SCREENSHOTS:
        path = Path(SCREENSHOTS)
        path.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path / filename), full_page=True, animations="disabled")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROMIUM_PATH, headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = desktop.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE_URL)
        expect(page.get_by_role("heading", name="Серверное железо для ИИ")).to_be_visible()
        expect(page.get_by_role("heading", name="Войдите, чтобы увидеть объявления")).to_be_visible()
        expect(page.locator(".category-tile")).to_have_count(6)
        expect(page.locator(".listing-card")).to_have_count(0)
        expect(page.locator(".hero-art img")).to_have_js_property("complete", True)
        assert page.locator(".hero-art img").evaluate("(img) => img.naturalWidth > 0")
        assert page.evaluate("document.fonts.check('800 28px Manrope', 'Каталог')")
        page.keyboard.press("Tab")
        expect(page.get_by_role("link", name="Перейти к содержимому")).to_be_focused()
        check_width(page)
        page.locator("h1").click()
        capture(page, "01-guest-desktop.png")

        page.get_by_role("button", name="GPU и ускорители").click()
        assert parse_qs(urlparse(page.url).query)["category"] == ["gpu"]
        page.get_by_role("textbox", name="Поиск оборудования").fill("NVIDIA")
        page.get_by_role("button", name="Найти", exact=True).click()
        expect(page).to_have_url(re.compile(r"q=NVIDIA"))
        page.locator(".locked-panel").get_by_role("link", name="Войти", exact=True).click()
        login(page, "test2")
        expect(page).to_have_url(re.compile(r"/catalog\?.*q=NVIDIA"))
        expect(page.locator(".listing-card").first).to_be_visible()
        assert "gpu" in parse_qs(urlparse(page.url).query)["category"]
        assert page.locator(".listing-card").count() >= 1
        check_width(page)
        capture(page, "02-buyer-desktop.png")

        page.locator(".listing-card").first.click()
        expect(page.get_by_role("heading", name="Условия сделки")).to_be_visible()
        expect(page.get_by_role("button", name="Написать")).to_be_visible()
        expect(page.get_by_text("test1@example", exact=False)).to_have_count(0)
        check_width(page)
        capture(page, "03-listing-desktop.png")
        detail_path = urlparse(page.url).path

        for width in (320, 390, 768, 1024):
            mobile = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=True, device_scale_factor=1, has_touch=True)
            touch = mobile.new_page()
            touch.on("pageerror", lambda error: errors.append(str(error)))
            touch.goto(BASE_URL)
            expect(touch.locator(".category-tile").first).to_be_visible()
            expect(touch.get_by_role("heading", name="Войдите, чтобы увидеть объявления")).to_be_visible()
            check_width(touch)
            if width <= 750:
                touch.get_by_role("button", name="Открыть меню").click()
                expect(touch.get_by_role("navigation", name="Основная навигация")).to_be_visible()
                touch.get_by_role("button", name="Закрыть меню").click()
                touch.get_by_role("button", name="Фильтры", exact=True).click()
                expect(touch.get_by_label("Тип продавца")).to_be_visible()
                touch.get_by_label("Тип продавца").select_option("COMPANY")
                expect(touch).to_have_url(re.compile("ownerType=COMPANY"))
                if width == 390:
                    capture(touch, "04-guest-mobile.png")
            touch.goto(BASE_URL + detail_path)
            expect(touch.get_by_role("heading", name="Объявление доступно участникам")).to_be_visible()
            check_width(touch)
            mobile.close()

        seller = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        seller_page = seller.new_page()
        seller_page.on("pageerror", lambda error: errors.append(str(error)))
        seller_page.goto(BASE_URL + "/login")
        login(seller_page, "test1")
        expect(seller_page.locator(".listing-card").first).to_be_visible()
        expect(seller_page.get_by_role("button", name="Заявки", exact=True)).to_have_attribute("aria-pressed", "true")
        expect(seller_page.get_by_role("link", name="Мои предложения")).to_be_visible()
        check_width(seller_page)
        capture(seller_page, "05-seller-mobile.png")
        seller_page.set_viewport_size({"width": 768, "height": 1024})
        check_width(seller_page)
        expect(seller_page.get_by_role("button", name="Открыть меню")).to_be_visible()
        seller_page.get_by_role("textbox", name="Поиск оборудования").fill("Проверка пустой выдачи 012301230123")
        seller_page.get_by_role("button", name="Найти", exact=True).click()
        expect(seller_page.get_by_role("heading", name="Объявления не найдены")).to_be_visible()
        seller_page.get_by_role("button", name="Очистить поиск").click()
        expect(seller_page.locator(".listing-card").first).to_be_visible()

        assert not errors, errors
        print("Catalogue UI passed: desktop and four viewport widths; guest lock, keyboard focus, URL filters, login return, both roles, detail, empty state.")
        browser.close()


if __name__ == "__main__":
    main()
