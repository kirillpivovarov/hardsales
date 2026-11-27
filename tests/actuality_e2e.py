"""Check the actuality workflow at 375px and 1280px on an isolated EXCHANGE_DEMO_FEATURES=true instance."""

import os

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import BASE, button, check_no_overflow, login


def exercise(browser, width, height):
    context = browser.new_context(viewport={"width": width, "height": height})
    try:
        page = context.new_page()
        login(page, "test1", "test1")
        expect(page.get_by_role("heading", name="Мои объявления", exact=True)).to_be_visible()
        banner = page.get_by_role("region", name="Подтверждение актуальности")
        expect(banner).to_be_visible()
        expect(banner.get_by_role("button", name="Все актуальны", exact=True)).to_be_visible()
        check_no_overflow(page)

        change = button(page, "Изменилась цена или количество").first
        change.click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        price = dialog.get_by_label("Новая цена за шт.")
        first_field = price if price.count() else dialog.get_by_label("Новое количество")
        expect(first_field).to_be_focused()
        check_no_overflow(page)
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(change).to_be_focused()

        button(page, "Архив").click()
        expect(button(page, "Архив")).to_have_attribute("aria-current", "page")
        button(page, "Активные").click()
        expect(page.get_by_text("Скрыто: нет ответа", exact=False).first).to_be_visible()
        check_no_overflow(page)

        page.goto(BASE + "/account")
        expect(page.get_by_role("heading", name="Пауза объявлений", exact=True)).to_be_visible()
        expect(button(page, "Поставить паузу")).to_be_visible()
        check_no_overflow(page)
    finally:
        context.close()


if __name__ == "__main__":
    with sync_playwright() as playwright:
        chromium = os.getenv("CHROMIUM_PATH")
        browser = playwright.chromium.launch(headless=True, executable_path=chromium)
        try:
            for viewport in ((375, 812), (1280, 900)):
                exercise(browser, *viewport)
        finally:
            browser.close()
    print("actuality UI keyboard, owner controls and responsive layout passed")
