"""Browser checks for privacy controls using an isolated demo and Mailpit."""

import gzip
import json
import os
import re
from pathlib import Path
from secrets import token_hex

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import BASE, button, check_no_overflow, mail_code

PASSWORD = "Separate-privacy-check-password-68!"


def call(context, path, method="GET", body=None, status=200):
    options = {"data": body} if body is not None else {}
    response = context.request.fetch(BASE + "/api/v1" + path, method=method, headers={"Origin": BASE}, **options)
    assert response.status == status, response.text()
    return response.json()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH") or None,
                                         headless=True, args=["--no-sandbox"])
    mobile = browser.new_context(viewport={"width": 375, "height": 812}, accept_downloads=True)
    desktop = browser.new_context(viewport={"width": 1440, "height": 900})

    page = mobile.new_page()
    page.goto(BASE + "/register")
    consent = page.get_by_role("checkbox", name=re.compile("Я даю согласие на обработку персональных данных"))
    expect(consent).not_to_be_checked()
    expect(button(page, "Получить код")).to_be_disabled()
    consent.focus()
    page.keyboard.press("Tab")
    policy = page.locator("form").get_by_role("link", name="Политика обработки персональных данных", exact=True)
    expect(policy).to_be_focused()
    expect(policy).to_have_attribute("href", "/info/pd_policy")
    check_no_overflow(page)

    call(mobile, "/auth/login", "POST", {"login": "test2", "password": "test2"})
    call(desktop, "/auth/login", "POST", {"login": "admin", "password": "admin"})
    call(desktop, "/auth/credentials", "PATCH", {"currentPassword": "admin", "newPassword": PASSWORD})
    admin = desktop.new_page()
    settings = "/admin?section=exchange&part=settings"
    admin.goto(BASE + settings)
    letter = admin.locator("section").filter(has=admin.get_by_role("heading", name="Письмо представителю компании"))
    letter = letter.filter(has=admin.get_by_label("Тема письма", exact=True)).last
    letter.get_by_label("Тема письма", exact=True).fill("Подтверждение представительства")
    letter.get_by_label("Текст письма", exact=False).fill(
        "Проверьте запрос на подтверждение по ссылке {link}. Политика {policyUrl}. Отказ {optOutUrl}.")
    letter.get_by_text("Предпросмотр", exact=True).click()
    expect(letter.get_by_text("/info/pd_policy", exact=False)).to_be_visible()
    button(letter, "Утвердить текст").click()
    expect(letter.get_by_text("Текст утверждён.", exact=True)).to_be_visible()

    page.goto(BASE + "/account")
    prefs = page.locator("#personal-data")
    expect(prefs.get_by_text("Согласие дано", exact=False)).to_be_visible()
    expect(prefs.get_by_role("checkbox", name="Информационные письма")).not_to_be_checked()
    prefs.get_by_role("checkbox", name="Информационные письма").click()
    expect(prefs.get_by_role("checkbox", name="Информационные письма")).to_be_checked()
    button(prefs, "Выгрузить мои данные").click()
    expect(prefs.get_by_text("Запрос принят.", exact=True)).to_be_visible()

    requests_route = "/admin?section=exchange&part=data-requests"
    admin.goto(BASE + requests_route)
    button(admin, "Сформировать").click()
    button(admin.get_by_role("dialog"), "Подтвердить").click()
    expect(admin.get_by_text("Запрос обработан.", exact=True)).to_be_visible()
    admin.get_by_role("combobox", name=re.compile("^Статус")).select_option("DONE")
    admin.get_by_role("link", name="История согласий", exact=True).click()
    expect(admin.get_by_role("heading", name="История согласий", exact=True)).to_be_visible()
    expect(admin.get_by_text("Информационные письма · Согласие", exact=True)).to_be_visible()

    page.reload()
    with page.expect_download() as incoming:
        prefs.get_by_role("link", name="Скачать", exact=True).click()
    assert json.loads(gzip.decompress(Path(incoming.value.path()).read_bytes()))["profile"]["username"] == "test2"
    button(prefs, "Отозвать согласие").click()
    dialog = page.get_by_role("dialog")
    check_no_overflow(page)
    dialog.get_by_label("Комментарий", exact=True).fill("Участник проверяет обработку заявки")
    button(dialog, "Подтвердить запрос").click()
    expect(prefs.get_by_text("Запрос принят.", exact=True)).to_be_visible()
    admin.goto(BASE + requests_route)
    button(admin, "Отклонить").click()
    dialog = admin.get_by_role("dialog")
    dialog.get_by_label("Причина отказа").fill("Пример причины для теста")
    button(dialog, "Подтвердить").click()
    expect(admin.get_by_text("Запрос обработан.", exact=True)).to_be_visible()
    page.reload()
    expect(prefs.get_by_text("Пример причины для теста", exact=True)).to_be_visible()
    check_no_overflow(page)

    marker = token_hex(4)
    moderator = browser.new_context()
    username = "privacy-mod-" + marker
    email = username + "@example.test"
    call(desktop, "/admin/moderators", "POST", {"username": username, "email": email,
        "displayName": "Модератор QA", "temporaryPassword": PASSWORD}, 201)
    temporary = call(moderator, "/auth/login", "POST", {"login": username, "password": PASSWORD})
    call(moderator, "/auth/verify", "POST", {"challengeId": temporary["challengeId"], "code": mail_code(email)})
    call(moderator, "/auth/password", "POST", {"currentPassword": PASSWORD, "newPassword": "Moderation-Privacy-Rotate-55!"})
    call(moderator, "/admin/data-requests", status=403)
    mod_page = moderator.new_page()
    mod_page.goto(BASE + requests_route)
    expect(mod_page.get_by_role("link", name="Модели оборудования", exact=True)).to_be_visible()
    expect(mod_page.get_by_role("link", name="Запросы по данным", exact=True)).to_have_count(0)
    print("OK mobile consent, preferences, requests and download; admin approval and rejection; moderator privacy boundaries")
