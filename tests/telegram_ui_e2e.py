"""Responsive account controls for the Telegram channel using a stubbed bot link.

Set HWFORAI_QA_BASE to a disposable demo instance and CHROMIUM_PATH when needed.
"""

from datetime import datetime, timedelta, timezone
import os

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import BASE, button, check_no_overflow, login


def check(width):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.getenv("CHROMIUM_PATH") or os.getenv("CHROMIUM_EXECUTABLE_PATH"),
            headless=True,
            args=["--no-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": width, "height": 812}, is_mobile=width == 375, has_touch=width == 375,
        )
        context.add_init_script("window.open = () => null;")
        page = context.new_page()
        calls = []
        state = {
            "enabled": True,
            "linked": False,
            "username": None,
            "botUsername": "hwforai_fixture_bot",
            "linkedAt": None,
            "disabledReason": None,
            "verified": False,
            "profileUsername": None,
        }
        url = "https://t.me/hwforai_fixture_bot?start=" + "T" * 43

        def telegram(route):
            method = route.request.method
            calls.append(method)
            if method == "DELETE":
                state.update(linked=False, username=None, linkedAt=None, disabledReason="PROFILE_UNLINK", verified=False)
                route.fulfill(json={"linked": False})
            else:
                route.fulfill(json=state)

        def issue(route):
            assert route.request.method == "POST"
            deadline = datetime.now(timezone.utc) + timedelta(minutes=15)
            route.fulfill(json={"url": url, "expiresAt": deadline.isoformat()})

        page.route("**/api/v1/me/telegram", telegram)
        page.route("**/api/v1/me/telegram/link", issue)
        login(page, "test1", "test1", "/account")
        page.wait_for_url("**/account")
        connect = button(page, "Подключить Telegram")
        expect(connect).to_be_visible()
        check_no_overflow(page)
        connect.focus()
        page.keyboard.press("Enter")
        expect(page.get_by_role("link", name="Открыть Telegram")).to_have_attribute("href", url)
        expect(page.get_by_text("Ссылка действует 15 минут.", exact=False)).to_be_visible()
        expect(page.get_by_text("не подтверждён", exact=False)).to_be_visible()

        state.update(linked=True, username="fixture_tg", linkedAt=datetime.now(timezone.utc).isoformat())
        button(page, "Проверить подключение").click()
        expect(page.get_by_text("Подключён @fixture_tg", exact=False)).to_be_visible()
        expect(button(page, "Подтвердить через бота")).to_be_visible()
        state.update(verified=True, profileUsername="fixture_tg")
        button(page, "Проверить подтверждение").click()
        expect(page.get_by_text("Telegram @fixture_tg: подтверждён", exact=True)).to_be_visible()
        expect(page.locator("input[name=telegram]")).to_have_value("fixture_tg")
        unlink = button(page, "Отвязать Telegram")
        unlink.focus()
        page.keyboard.press("Enter")
        dialog = page.get_by_role("dialog", name="Отвязать Telegram")
        expect(dialog).to_be_visible()
        check_no_overflow(page)
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(unlink).to_be_focused()
        page.keyboard.press("Enter")
        approve = dialog.get_by_role("button", name="Отвязать", exact=True)
        approve.focus()
        page.keyboard.press("Enter")
        expect(dialog).not_to_be_visible()
        expect(connect).to_be_visible()
        assert calls.count("DELETE") == 1
        check_no_overflow(page)
        browser.close()
        print(f"Telegram controls passed on {width} px at {BASE}")


if __name__ == "__main__":
    for viewport in (375, 1280):
        check(viewport)
