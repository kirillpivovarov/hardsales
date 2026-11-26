"""HTTPS signup using the published consent version, CAPTCHA and SMTP STARTTLS.

Run after the isolated production.integration.test.mjs on the same database.
Pass APP_ORIGIN, MAILPIT_URL, and the moderator username/password used by that test.
"""
import json
import os
import re
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20_000)

BASE = os.environ["APP_ORIGIN"]
MAIL = os.environ["MAILPIT_URL"]
PASSWORD = "Release-browser-captcha-test-21!"


def mailbox_messages(mailbox):
    query = urlencode({"query": f"to:{mailbox}"})
    with urlopen(f"{MAIL}/api/v1/search?{query}", timeout=5) as response:
        return json.load(response)["messages"] or []


def fetch_mail(mailbox, previous=()):
    for _ in range(60):
        message = next((item for item in mailbox_messages(mailbox) if item["ID"] not in previous), None)
        if message:
            with urlopen(f"{MAIL}/api/v1/message/{message['ID']}", timeout=5) as response:
                details = json.load(response)
            assert details["From"]["Address"].startswith("no-reply@")
            code = re.search(r"\b\d{6}\b", details["Text"])
            if code:
                return code.group(0)
        time.sleep(0.1)
    raise AssertionError(f"Verification email missing for {mailbox}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"), args=["--no-sandbox", "--disable-dev-shm-usage"])
    for role, device in [("BUYER", "Pixel 7"), ("SELLER", "iPad Mini")]:
        context = browser.new_context(**playwright.devices[device], ignore_https_errors=True)
        page = context.new_page()
        external = []
        page_errors = []
        challenge_statuses = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        def observe(request):
            endpoint = urlsplit(request.url)
            if endpoint.scheme in {"http", "https"} and endpoint.netloc != urlsplit(BASE).netloc:
                external.append(request.url)

        def allow_only_application(route):
            endpoint = urlsplit(route.request.url)
            if endpoint.scheme in {"http", "https"} and endpoint.netloc != urlsplit(BASE).netloc:
                route.abort()
            else:
                route.continue_()

        context.route("**/*", allow_only_application)
        context.on("request", observe)
        context.on("response", lambda reply: challenge_statuses.append(reply.status)
                if urlsplit(reply.url).path == "/api/v1/auth/captcha" else None)
        response = page.goto(f"{BASE}/register")
        assert response.ok
        assert "cloudflare" not in response.headers["content-security-policy"]
        submit = page.get_by_role("button", name="Получить код")
        tag = uuid4().hex[:8]
        login = "browser_" + tag
        email = login + "@example.test"
        page.locator("[name=role]").select_option(role)
        page.locator("[name=username]").fill(login)
        page.locator("[name=email]").fill(email)
        page.locator("[name=city]").fill("Екатеринбург")
        page.locator("[name=telegram]").fill(login)
        page.locator("[name=password]").fill(PASSWORD)
        expect(submit).to_be_disabled()
        page.locator("[name=pdConsent]").check()
        expect(submit).to_be_disabled()
        widget = page.locator("altcha-widget")
        checkbox = widget.get_by_role("checkbox")
        solve = widget.get_by_text("Я не робот", exact=True)
        expect(checkbox).to_be_visible()
        initial_viewport = page.viewport_size
        page.set_viewport_size({"width": 320, "height": initial_viewport["height"]})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.set_viewport_size(initial_viewport)
        if role == "BUYER":
            page.route(f"{BASE}/api/v1/auth/captcha", lambda route: route.abort(), times=1)
            solve.tap()
            expect(widget.get_by_text("Проверка не удалась. Повторите попытку.")).to_be_visible()
            expect(submit).to_be_disabled()
            solve.tap()
        else:
            solve.tap()
        expect(submit).to_be_enabled()
        assert challenge_statuses == [200], challenge_statuses
        with page.expect_response(lambda reply: reply.url.endswith("/api/v1/auth/register")) as pending:
            submit.click()
        assert pending.value.status == 201, pending.value.text()
        assert pending.value.header_value("set-cookie") is None
        expect(page.get_by_role("heading", name="Подтвердите почту")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        code = fetch_mail(email)
        invalid = str((int(code) + 1) % 1_000_000).zfill(6)
        page.locator("[name=code]").fill(invalid)
        verify = page.get_by_role("button", name="Подтвердить", exact=True)
        verify.click()
        expect(page.get_by_role("alert")).to_be_visible()
        assert page.request.get(BASE + "/api/v1/auth/me").json()["user"] is None
        page.locator("[name=code]").fill(code)
        with page.expect_response(lambda reply: reply.url.endswith("/api/v1/auth/verify")) as verified:
            verify.click()
        assert verified.value.status == 200, verified.value.text()
        headers = verified.value.header_value("set-cookie")
        assert all(name in headers for name in ["Secure", "HttpOnly", "SameSite=Lax"]), headers
        page.wait_for_url("**/catalog")
        user = page.request.get(BASE + "/api/v1/auth/me").json()["user"]
        assert user["role"] == role and user["username"] == login and user["emailVerified"]
        assert user["pdConsentVersion"] == "1.0" and user["infoEmailConsent"] is False
        assert not page_errors, page_errors
        assert not external, external
        context.close()
        print(f"PASS {role} {device}: same-origin CAPTCHA and packaged solver, real STARTTLS email, rejected bad OTP, accepted correct OTP, secure HTTPS session.", flush=True)
    moderator = browser.new_context(**playwright.devices["Pixel 7"], ignore_https_errors=True)
    page = moderator.new_page()
    page.goto(f"{BASE}/login")
    username = os.environ["HWFORAI_PRODUCTION_MODERATOR_USERNAME"]
    password = os.environ["HWFORAI_PRODUCTION_MODERATOR_PASSWORD"]
    email = username + "@example.test"
    previous = {item["ID"] for item in mailbox_messages(email)}
    page.locator("[name=login]").fill(username)
    page.locator("[name=password]").fill(password)
    with page.expect_response(lambda reply: reply.url.endswith("/api/v1/auth/login")) as login:
        page.locator('form button[type="submit"]').click()
    assert login.value.status == 200
    assert login.value.header_value("set-cookie") is None
    expect(page.get_by_role("heading", name="Подтвердите вход")).to_be_visible()
    page.locator("[name=code]").fill(fetch_mail(email, previous))
    page.get_by_role("button", name="Подтвердить", exact=True).click()
    expect(page.get_by_role("heading", name="Администрирование", exact=True)).to_be_visible()
    assert page.request.get(BASE + "/api/v1/auth/me").json()["user"]["role"] == "MODERATOR"
    for width in (320, 768, 1440):
        page.set_viewport_size({"width": width, "height": 960})
        expect(page.get_by_role("heading", name="Администрирование", exact=True)).to_be_visible()
        expect(page.get_by_role("link", name="Модераторы", exact=True)).to_have_count(0)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    moderator.close()
    print("PASS production moderator: STARTTLS OTP login, staff UI and owner-only controls hidden at 320/768/1440 px.", flush=True)
    browser.close()
