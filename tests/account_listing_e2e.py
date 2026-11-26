"""Browser regression for sign-up, SMTP OTP, profile, and listing lifecycle.

Run against an isolated demo instance with seeded credentials and Mailpit:
    HWFORAI_QA_BASE=http://127.0.0.1:3000 python tests/account_listing_e2e.py
Optionally set HWFORAI_QA_MAILPIT_URL and CHROMIUM_PATH.
"""

import json
import os
import re
import time
from datetime import date, timedelta
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import urlopen

from playwright.sync_api import Page, expect, sync_playwright

from country_controls import choose_country

BASE = os.getenv("HWFORAI_QA_BASE", "http://127.0.0.1:3000").rstrip("/")
MAILPIT = os.getenv("HWFORAI_QA_MAILPIT_URL", "http://127.0.0.1:8025").rstrip("/")
MARKER = str(time.time_ns())[-10:]
PASSWORD = "MarketQA-Check-2026"
NEW_PASSWORD = "MarketQA-New-Password-2026"


def mail_code(email: str, previous: str | None = None) -> str:
    for _ in range(25):
        query = urlencode({"query": f"to:{email}"})
        with urlopen(f"{MAILPIT}/api/v1/search?{query}", timeout=6) as response:
            messages = json.load(response).get("messages") or []
        for message in messages:
            message_id = message.get("ID") or message.get("id")
            with urlopen(f"{MAILPIT}/api/v1/message/{message_id}", timeout=6) as response:
                content = json.load(response)
            code = re.search(r"\b([0-9]{6})\b", content.get("Text", ""))
            if code and code.group(1) != previous:
                return code.group(1)
        time.sleep(0.2)
    raise AssertionError("Confirmation code never appeared in Mailpit")


def field(page: Page, name: str):
    return page.locator(f'input[name="{name}"], textarea[name="{name}"], select[name="{name}"]')


def heading(page: Page, title: str):
    return page.get_by_role("heading", name=title, exact=True)


def button(page: Page, label: str):
    return page.get_by_role("button", name=label, exact=True)


def current_user(page: Page):
    response = page.request.get(BASE + "/api/v1/auth/me")
    assert response.ok, response.text()
    return response.json()["user"]


def check_no_overflow(page: Page):
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), page.url


def logout(page: Page):
    response = page.request.post(BASE + "/api/v1/auth/logout", headers={"Origin": BASE})
    assert response.ok, response.text()
    page.goto(BASE + "/login")


def login(page: Page, login_id: str, password: str, next_path="/my-listings"):
    page.goto(BASE + "/login?next=" + quote(next_path, safe=""))
    field(page, "login").fill(login_id)
    field(page, "password").fill(password)
    button(page, "Войти").click()


def complete_otp(page: Page, email: str, *, previous_code: str | None = None, test_incorrect=False):
    expect(field(page, "code")).to_be_visible()
    code = mail_code(email, previous_code)
    if test_incorrect:
        invalid = str((int(code) + 1) % 1_000_000).zfill(6)
        field(page, "code").fill(invalid)
        button(page, "Подтвердить").click()
        expect(page.get_by_role("alert")).to_be_visible()
        assert current_user(page) is None
    field(page, "code").fill(code)
    button(page, "Подтвердить").click()
    return code


def registration_test(page: Page):
    email = f"company-{MARKER}@example.com"
    username = f"market.qa-{MARKER}"
    next_path = "/listings/new"

    page.goto(BASE + "/login?next=" + quote(next_path, safe=""))
    page.get_by_role("link", name="Зарегистрироваться").click()
    expect(heading(page, "Регистрация")).to_be_visible()
    captcha = page.locator("altcha-widget").get_by_role("checkbox")
    expect(captcha).to_be_visible(timeout=15000)
    page.locator(".workflow-auth-links").get_by_role("link", name="Войти", exact=True).click()
    expect(heading(page, "Вход в аккаунт")).to_be_visible()
    page.get_by_role("link", name="Зарегистрироваться").click()
    expect(heading(page, "Регистрация")).to_be_visible()
    expect(captcha).to_be_visible(timeout=15000)
    check_no_overflow(page)
    field(page, "role").select_option("SELLER")
    field(page, "participantType").select_option("COMPANY")
    expect(field(page, "companyName")).to_be_visible()
    field(page, "companyName").fill("Тестовый поставщик оборудования")
    field(page, "username").fill("☃##")
    assert not field(page, "username").evaluate("(input) => input.checkValidity()")
    field(page, "username").fill(username)
    field(page, "email").fill(email)
    field(page, "city").fill("Новосибирск")
    field(page, "telegram").fill(f"@market{MARKER}")
    field(page, "password").fill(PASSWORD)
    submit = button(page, "Получить код")
    expect(submit).to_be_disabled()
    page.locator('input[name="pdConsent"]').check()
    expect(submit).to_be_disabled()
    captcha.press("Space")
    expect(submit).to_be_enabled(timeout=15000)
    submit.click()

    expect(heading(page, "Подтвердите почту")).to_be_visible()
    expect(page.get_by_role("button", name=re.compile("Отправить ещё раз через"))).to_be_disabled()
    code = complete_otp(page, email, test_incorrect=True)
    expect(heading(page, "Новое объявление")).to_be_visible()
    user = current_user(page)
    assert user["emailVerified"] and user["username"] == username
    assert user["role"] == "SELLER" and user["participantType"] == "COMPANY"

    page.goto(BASE + "/account")
    check_no_overflow(page)
    field(page, "displayName").fill("Тестовая компания")
    field(page, "city").fill("Томск")
    button(page, "Сохранить профиль").click()
    expect(page.get_by_text("Профиль обновлён.", exact=True)).to_be_visible()
    assert current_user(page)["city"] == "Томск"
    field(page, "currentPassword").fill(PASSWORD)
    field(page, "newPassword").fill(NEW_PASSWORD)
    field(page, "confirmPassword").fill("MarketQA-Mismatch-2026")
    button(page, "Сменить пароль").click()
    expect(page.get_by_text("Новые пароли не совпадают.", exact=True)).to_be_visible()
    field(page, "confirmPassword").fill(NEW_PASSWORD)
    button(page, "Сменить пароль").click()
    expect(page.get_by_text("Данные для входа обновлены.", exact=True)).to_be_visible()
    logout(page)

    login(page, username, PASSWORD)
    expect(page.get_by_role("alert")).to_be_visible()
    assert current_user(page) is None
    login(page, username, NEW_PASSWORD)
    expect(heading(page, "Подтвердите вход")).to_be_visible()
    complete_otp(page, email, previous_code=code)
    expect(heading(page, "Мои объявления")).to_be_visible()
    assert current_user(page)["displayName"] == "Тестовая компания"


def listing_test(page: Page, kind: str):
    page.goto(BASE + "/listings/new")
    expect(heading(page, "Новое объявление")).to_be_visible()
    check_no_overflow(page)
    title = f"Сервер для QA {kind} {MARKER[:5]}qa{MARKER[5:]}"
    field(page, "title").fill(title)
    field(page, "categoryId").select_option(index=1)
    description = "Проверяем публикацию, редактирование и архивирование объявления."
    field(page, "description").fill(description)
    field(page, "quantity").fill("3")
    field(page, "price").fill("1250000")
    check_no_overflow(page)
    field(page, "vat").select_option("EXCLUDED")
    payment = page.locator('input[name="paymentMethods"][value="LETTER_OF_CREDIT"]')
    payment.check()
    field(page, "deliveryIncluded").check()
    field(page, "customsIncluded").check()

    if kind == "BUY":
        assert field(page, "availability").count() == 0
        field(page, "originScope").select_option("COUNTRY")
        choose_country(page, "originCountry", "CN")
        choose_country(page, "destinationCountry", "RU")
        field(page, "counterparty").select_option("COMPANY")
        field(page, "deliveryBy").fill((date.today() + timedelta(days=30)).isoformat())
    else:
        expect(field(page, "stockCity")).to_be_visible()
        field(page, "availability").select_option("TRANSIT")
        expect(field(page, "stockCity")).to_have_count(0)
        field(page, "availability").select_option("STOCK")
        field(page, "stockCity").fill("Новосибирск")

    if kind == "SELL":
        field(page, "description").fill(description + " Связь через @marketexample.")
        button(page, "Опубликовать объявление").click()
        expect(page.get_by_role("alert")).to_contain_text("Уберите контакты")
        field(page, "description").fill(description)
    button(page, "Опубликовать объявление").click()
    page.wait_for_url(re.compile(r".*/listings/[a-f0-9-]{36}$"))
    listing_path = urlsplit(page.url).path
    response = page.request.get(BASE + "/api/v1" + listing_path)
    assert response.ok, response.text()
    listing = response.json()
    assert listing["kind"] == kind and listing["title"] == title
    assert listing["quantity"] == 3 and listing["price"] == 1250000
    assert listing["deliveryIncluded"] and listing["customsIncluded"]
    assert listing["vat"] == "EXCLUDED"
    assert "LETTER_OF_CREDIT" in listing["paymentMethods"]
    if kind == "SELL":
        assert listing["stockCity"] == "Новосибирск"
    else:
        assert listing["originCountry"] == "CN"

    page.goto(BASE + "/my-listings")
    item = page.get_by_role("listitem").filter(has_text=title)
    item.get_by_role("link", name="Редактировать").click()
    expect(heading(page, "Редактирование объявления")).to_be_visible()
    field(page, "priceMode").select_option("NEGOTIABLE")
    expect(field(page, "price")).to_have_count(0)
    if kind == "SELL":
        field(page, "availability").select_option("TRANSIT")
        expect(field(page, "stockCity")).to_have_count(0)
    else:
        field(page, "originScope").select_option("ANY")
        expect(field(page, "originCountry")).to_have_count(0)
    button(page, "Сохранить изменения").click()
    page.wait_for_url(BASE + listing_path)
    updated = page.request.get(BASE + "/api/v1" + listing_path).json()
    assert updated["price"] is None and updated["priceMode"] == "NEGOTIABLE"
    cleared_field = "stockCity" if kind == "SELL" else "originCountry"
    assert updated[cleared_field] is None

    page.goto(BASE + listing_path + "/edit")
    expect(heading(page, "Редактирование объявления")).to_be_visible()
    if kind == "SELL":
        field(page, "availability").select_option("ORDER")
        expect(field(page, "stockCity")).to_have_count(0)
        choose_country(page, "originCountry", "KZ")
    else:
        field(page, "originScope").select_option("DOMESTIC")
        expect(field(page, "originCountry")).to_have_count(0)
        choose_country(page, "destinationCountry", "KZ")
    button(page, "Сохранить изменения").click()
    page.wait_for_url(BASE + listing_path)
    updated = page.request.get(BASE + "/api/v1" + listing_path).json()
    assert updated["originCountry"] == "KZ"
    if kind == "SELL":
        assert updated["availability"] == "ORDER" and updated["stockCity"] is None
    else:
        assert updated["originScope"] == "DOMESTIC" and updated["destinationCountry"] == "KZ"

    page.goto(BASE + "/my-listings")
    item.get_by_role("button", name="В архив", exact=True).click()
    item.get_by_role("button", name="Отмена", exact=True).click()
    expect(item.get_by_role("link", name="Открыть")).to_be_visible()
    item.get_by_role("button", name="В архив", exact=True).click()
    item.get_by_role("button", name="Перенести в архив", exact=True).click()
    expect(item.get_by_text("В архиве", exact=False)).to_be_visible()
    item.get_by_role("button", name="Опубликовать снова", exact=True).click()
    expect(item.get_by_role("link", name="Открыть")).to_be_visible()
    item.get_by_role("button", name="В архив", exact=True).click()
    item.get_by_role("button", name="Перенести в архив", exact=True).click()
    expect(item.get_by_text("В архиве", exact=False)).to_be_visible()


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.getenv("CHROMIUM_PATH"),
            args=["--no-sandbox", "--disable-dev-shm-usage"], headless=True,
        )
        contexts = [
            browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, locale="ru-RU"),
            browser.new_context(viewport={"width": 1440, "height": 900}, locale="ru-RU"),
        ]
        pages = [context.new_page() for context in contexts]
        errors = []
        for page in pages:
            page.set_default_timeout(10_000)
            page.on("pageerror", lambda error: errors.append(str(error)))

        seller, buyer = pages
        registration_test(seller)
        listing_test(seller, "SELL")
        print("PASS mobile: company registration over SMTP, OTP retry and login, profile, seller listings")
        login(buyer, "test2", "test2")
        expect(heading(buyer, "Мои объявления")).to_be_visible()
        assert current_user(buyer)["role"] == "BUYER"
        listing_test(buyer, "BUY")
        print("PASS desktop: seeded buyer login, purchase listing, edit, archive and republish")
        logout(buyer)
        login(buyer, "test2", "test2", "//example.com")
        buyer.wait_for_url(BASE + "/catalog")
        print("PASS redirect guard: external link rejected")
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    run()
