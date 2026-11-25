"""Country order, focus, and form submission on an isolated demo.

Set HWFORAI_COUNTRY_QA_URL to the site and CHROMIUM_PATH if needed. The
scenario changes a demo profile and rotates the demo administrator credentials.
"""
import os
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from country_controls import choose_country, country_control, open_countries


BASE = os.getenv("HWFORAI_COUNTRY_QA_URL", "http://127.0.0.1:3000").rstrip("/")
CHROMIUM = os.getenv("CHROMIUM_PATH")
COUNTRY_ORDER = ["RU", "KZ", "KG", "UZ", "AZ", "AM", "BY", "MD", "TJ", "TM", "AE", "CN"]


def assert_order(popup):
    expect(popup).to_be_visible()
    countries = popup.locator('[role="option"][data-value]').evaluate_all(
        "(options) => options.filter(option => /^[A-Z]{2}$/.test(option.dataset.value)).map(option => option.dataset.value)"
    )
    assert countries[:len(COUNTRY_ORDER)] == COUNTRY_ORDER, countries[:len(COUNTRY_ORDER)]
    assert popup.locator('[role="option"][data-value]').evaluate_all(
        """options => {
          const tail = options.filter(option => /^[A-Z]{2}$/.test(option.dataset.value)).slice(12);
          const collator = new Intl.Collator(document.documentElement.lang);
          return tail.every((row, index) => index === 0 || collator.compare(tail[index - 1].textContent, row.textContent) <= 0);
        }"""
    )
    expect(popup.locator('[data-value="KG"]')).to_have_text("Кыргызстан")
    assert popup.evaluate("(element) => element.scrollTop") == 0
    assert len(countries) == len(set(countries))
    assert popup.evaluate("""element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }""")


def check_control(scope, name):
    popup = open_countries(scope, name)
    assert_order(popup)
    country_control(scope, name).press("Escape")
    expect(popup).to_be_hidden()


def login(page, name, route):
    page.goto("/login?next=" + route)
    page.locator('input[name="login"]').fill(name)
    page.locator('input[name="password"]').fill(name)
    with page.expect_response(lambda response: response.url.endswith("/api/v1/auth/login")) as pending:
        page.get_by_role("button", name="Войти", exact=True).click()
    assert pending.value.ok, pending.value.text()
    page.wait_for_url(BASE + route)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROMIUM, args=["--no-sandbox"])
        mobile = browser.new_context(base_url=BASE, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        guest = mobile.new_page()
        guest.goto("/register")
        control = country_control(guest, "country")
        control.scroll_into_view_if_needed()
        scroll_before = guest.evaluate("window.scrollY")
        popup = open_countries(guest, "country")
        assert_order(popup)
        assert guest.evaluate("window.scrollY") == scroll_before
        popup.locator('[data-value="JP"]').click()
        expect(control).to_have_text("Япония")
        popup = open_countries(guest, "country")
        assert_order(popup)
        expect(popup.locator('[data-value="JP"]')).to_have_attribute("aria-selected", "true")
        control.press("Escape")
        expect(control).to_be_focused()
        popup = open_countries(guest, "country")
        control.click()
        expect(popup).to_be_hidden()

        login(guest, "test1", "/account")
        check_control(guest, "country")
        choose_country(guest, "country", "KG")
        with guest.expect_response(lambda response: response.url.endswith("/api/v1/auth/profile")) as pending:
            guest.get_by_role("button", name="Сохранить профиль").click()
        assert pending.value.ok, pending.value.text()
        assert pending.value.json()["user"]["country"] == "KG"
        guest.goto("/listings/new")
        popup = open_countries(guest, "originCountry")
        assert_order(popup)
        expect(popup.locator('[data-value="ANY"]')).to_have_text("Из любой страны")
        country_control(guest, "originCountry").press("Escape")
        check_control(guest, "destinationCountry")
        assert guest.evaluate("document.documentElement.scrollWidth") <= 390
        print("PASS mobile register, seller profile and both geography fields", flush=True)

        desktop = browser.new_context(base_url=BASE, viewport={"width": 1440, "height": 900})
        buyer = desktop.new_page()
        login(buyer, "test2", "/catalog")
        popup = open_countries(buyer, "originCountry")
        assert_order(popup)
        expect(popup.locator('[data-value="ANY"]')).to_have_text("Указана любая страна")
        popup.locator('[data-value="RU"]').click()
        expect(buyer).to_have_url(re.compile("country=RU"))
        buyer.get_by_text("Ещё фильтры", exact=True).click()
        check_control(buyer, "destinationCountry")

        buyer.goto("/listings/new")
        buyer.locator('select[name="originScope"]').select_option("COUNTRY")
        check_control(buyer, "destinationCountry")
        control = country_control(buyer, "originCountry")
        assert not buyer.locator('select[name="originCountry"]').evaluate("(element) => element.checkValidity()")
        expect(control).to_be_focused()
        expect(control).to_have_attribute("aria-invalid", "true")
        control.press("ArrowDown")
        popup = buyer.get_by_role("listbox")
        assert_order(popup)
        control.press("ArrowDown")
        control.press("Enter")
        expect(control).to_have_text("Казахстан")
        assert buyer.locator('select[name="originCountry"]').input_value() == "KZ"
        popup = open_countries(buyer, "originCountry")
        assert_order(popup)
        control.dispatch_event("keydown", {"key": "У", "bubbles": True})
        control.dispatch_event("keydown", {"key": "з", "bubbles": True})
        control.press("Enter")
        expect(control).to_have_text("Узбекистан")
        assert buyer.locator('select[name="originCountry"]').input_value() == "UZ"
        print("PASS desktop buyer filters, delivery fields and keyboard country selection", flush=True)

        adminctx = browser.new_context(base_url=BASE, viewport={"width": 768, "height": 864}, has_touch=True)
        admin = adminctx.new_page()
        login(admin, "admin", "/account")
        admin.locator('input[name="username"]').fill("country-moderator-" + uuid4().hex[:6])
        admin.locator('input[name="currentPassword"]').fill("admin")
        admin.locator('input[name="newPassword"]').fill("Country-QA-Fixture-2026")
        admin.locator('input[name="confirmPassword"]').fill("Country-QA-Fixture-2026")
        with admin.expect_response(lambda response: response.url.endswith("/api/v1/auth/credentials"), timeout=20000) as pending:
            admin.get_by_role("button", name="Обновить данные для входа").click()
        assert pending.value.ok, pending.value.text()
        admin.wait_for_url(BASE + "/admin")
        row = admin.get_by_role("row").filter(has_text="test2")
        row.get_by_role("button", name="Редактировать", exact=True).click()
        dialog = admin.get_by_role("dialog")
        check_control(dialog, "country")
        expect(dialog).to_be_visible()
        choose_country(dialog, "country", "AE")
        with admin.expect_response(lambda response: "/api/v1/admin/users/" in response.url and response.request.method == "PATCH") as saved:
            dialog.get_by_role("button", name="Сохранить", exact=True).click()
        assert saved.value.ok, saved.value.text()
        expect(dialog).to_be_hidden()
        expect(admin.get_by_role("row").filter(has_text="test2")).to_contain_text("ОАЭ")
        print("PASS administrator tablet dialog, Escape and ISO form submission", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
