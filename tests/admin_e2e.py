"""Admin browser regression for a fresh, disposable demo database.

Run with a Playwright Chromium installation or set HWFORAI_QA_CHROMIUM to
an installed Chromium binary. Set HWFORAI_ADMIN_QA_URL to the demo server.
The test rotates the demo administrator password and creates moderation fixtures.
"""

import json
import os
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("HWFORAI_ADMIN_QA_URL", "http://127.0.0.1:3017").rstrip("/")
CHROMIUM = os.environ.get("HWFORAI_QA_CHROMIUM")
TAG = uuid4().hex[:8]
PASSWORD = "Admin-QA-Fixture-2026"


def complete(message):
    print(f"PASS: {message}", flush=True)


def checked(condition, message):
    assert condition, message


def api(client, method, path, body=None):
    kwargs = {"data": body} if body is not None else {}
    response = client.fetch(f"{BASE}/api/v1/{path}", method=method, **kwargs)
    checked(response.ok, f"{method} {path} returned {response.status}: {response.text()}")
    return response.json() if response.status != 204 else None


def heading(page, title):
    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=15000)


def section(page, name):
    page.get_by_role("navigation", name="Разделы администрирования").get_by_role("link", name=name, exact=True).click()
    heading(page, name)


def search(page, text):
    page.get_by_role("searchbox").fill(text)
    page.get_by_role("button", name="Найти", exact=True).click()


def row(page, text):
    item = page.get_by_role("row").filter(has_text=text)
    expect(item).to_have_count(1)
    return item


def dialog_for(item, action):
    item.get_by_role("button", name=action, exact=True).click()
    dialog = item.page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    return dialog


def saved(page):
    expect(page.get_by_text("Изменения сохранены.", exact=True)).to_be_visible()
    expect(page.get_by_role("dialog")).not_to_be_visible()


def change_status(page, item, button, status, reason):
    dialog = dialog_for(item, button)
    dialog.get_by_label("Новый статус").select_option(value=status)
    dialog.get_by_label("Причина").fill(reason)
    if status == "BANNED":
        dialog.get_by_role("checkbox", name="Подтверждаю бессрочную блокировку").check()
    dialog.get_by_role("button", name="Применить статус").click()
    saved(page)


def verify_width(page, pixels):
    page.set_viewport_size({"width": pixels, "height": 864})
    scroll_width = page.evaluate("() => document.documentElement.scrollWidth")
    checked(scroll_width <= pixels, f"Unexpected horizontal scrolling at {pixels}px: {scroll_width}px")


def login_form(page, username, password):
    page.get_by_label("Логин или электронная почта").fill(username)
    page.get_by_label("Пароль", exact=True).fill(password)
    with page.expect_response(lambda response: response.url.endswith("/api/v1/auth/login")) as pending:
        page.get_by_role("button", name="Войти", exact=True).click()
    response = pending.value
    checked(response.ok and "user" in response.json(), f"Demo login failed: {response.status} {response.text()}")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=["--no-sandbox"])
        admin = browser.new_context(viewport={"width": 1420, "height": 960})
        guest = browser.new_context()
        buyer = browser.new_context()
        seller = browser.new_context()
        page = admin.new_page()
        page.set_default_timeout(10000)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(BASE + "/admin")
        heading(page, "Вход в аккаунт")
        admin_username = os.environ.get("HWFORAI_ADMIN_QA_USERNAME", "admin")
        admin_password = os.environ.get("HWFORAI_ADMIN_QA_PASSWORD", "admin")
        login_form(page, admin_username, admin_password)
        page.wait_for_url(re.compile(r"/(account|admin)$"))
        rotated = page.url.endswith("/account")
        if (admin_username, admin_password) == ("admin", "admin"):
            checked(rotated, "Demo administrator unexpectedly skipped credential rotation")
        if rotated:
            username = f"moderator-{TAG}"
            page.locator("input[name=username]").fill(username)
            page.locator("input[name=currentPassword]").fill(admin_password)
            page.locator("input[name=newPassword]").fill(PASSWORD)
            page.locator("input[name=confirmPassword]").fill(PASSWORD)
            page.get_by_role("button", name="Обновить данные для входа").click()
        heading(page, "Администрирование")
        heading(page, "Пользователи")
        if rotated:
            expired_login = guest.request.post(f"{BASE}/api/v1/auth/login", data={"login": admin_username, "password": admin_password})
            checked(expired_login.status == 401, "Old admin credentials still work")
            user = api(admin.request, "POST", "auth/login", {"login": username, "password": PASSWORD})["user"]
            checked(user["username"] == username and not user["mustChangePassword"], "New admin credentials did not persist")
            section(page, "Журнал действий")
            expect(page.locator(".admin-table").get_by_text("Смена данных для входа", exact=True)).to_be_visible()
            section(page, "Пользователи")
        complete("Гостевой редирект, вход и смена реквизитов администратора")

        api(buyer.request, "POST", "auth/login", {"login": "test2", "password": "test2"})
        buyer_page = buyer.new_page()
        buyer_page.goto(BASE + "/admin")
        buyer_page.wait_for_url(re.compile(r"/catalog$"))
        denied = buyer.request.get(f"{BASE}/api/v1/admin/users")
        checked(denied.status == 403, "Ordinary member unexpectedly has access to admin data")
        complete("Запрет администрирования для покупателя")

        search(page, "test1")
        item = row(page, "test1")
        dialog = dialog_for(item, "Редактировать")
        original_city = dialog.get_by_label("Город").input_value()
        city = "Тестовый город " + TAG
        dialog.get_by_label("Город").fill(city)
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        expect(row(page, "test1").get_by_text(city, exact=False)).to_be_visible()

        api(seller.request, "POST", "auth/login", {"login": "test1", "password": "test1"})
        me = api(seller.request, "GET", "auth/me")["user"]
        checked(me["city"] == city, "Edited profile data did not persist")
        change_status(page, row(page, "test1"), "Статус", "FROZEN", f"Тест заморозки {TAG}")
        expect(row(page, "test1").get_by_text("Заморожен")).to_be_visible()
        checked(api(seller.request, "GET", "auth/me")["user"] is None, "Frozen account retained access")
        change_status(page, row(page, "test1"), "Статус", "ACTIVE", f"Тест восстановления {TAG}")
        dialog = dialog_for(row(page, "test1"), "Редактировать")
        dialog.get_by_label("Город").fill(original_city)
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        complete("Редактирование, заморозка и восстановление профиля")

        section(page, "Категории")
        page.get_by_role("button", name="Добавить категорию").click()
        dialog = page.get_by_role("dialog")
        category_name = "Тестовая категория " + TAG
        category_slug = "test-" + TAG
        dialog.get_by_label("Название категории", exact=True).fill(category_name)
        dialog.get_by_label("Короткое название", exact=False).fill("Тест " + TAG)
        dialog.get_by_label("Код в каталоге", exact=False).fill(category_slug)
        dialog.get_by_label("Порядок сортировки").fill("1")
        dialog.get_by_label("Значок").fill("power")
        dialog.get_by_label("Характеристики", exact=False).fill("Модель, Интерфейс")
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        expect(row(page, category_name)).to_be_visible()
        created_category = next(item for item in api(guest.request, "GET", "categories") if item["slug"] == category_slug)
        checked(created_category["attributeKeys"] == ["Модель", "Интерфейс"], "Category attributes did not persist")
        guest_page = guest.new_page()
        guest_page.on("pageerror", lambda error: errors.append(str(error)))
        guest_page.goto(BASE + "/catalog")
        first_tile = guest_page.locator(".category-tile").first
        expect(first_tile).to_have_text("Тест " + TAG)
        expect(first_tile.locator(".lucide-zap")).to_be_visible()
        first_tile.click()
        expect(guest_page).to_have_url(re.compile(rf"category={category_slug}"))
        complete("Создание категории и отражение порядка, значка и ссылки в каталоге")

        section(page, "Объявления")
        category_id = created_category["id"]
        api(seller.request, "POST", "auth/login", {"login": "test1", "password": "test1"})
        offer_title = "Тестовое серверное предложение " + TAG
        listing = api(seller.request, "POST", "listings", {
            "title": offer_title,
            "description": "Тестовый сервер для проверки административных операций.",
            "kind": "SELL", "categoryId": category_id, "quantity": 1,
            "condition": "NEW", "priceMode": "FIXED", "price": 600000, "currency": "RUB",
            "availability": "STOCK", "originCountry": "RU", "stockCity": "Москва",
            "deliveryIncluded": True, "customsIncluded": False, "vat": "INCLUDED",
            "counterparty": "COMPANY", "paymentMethods": ["BANK_TRANSFER"],
        })
        listing_id = listing["id"]
        profile = api(buyer.request, "GET", "auth/me")["user"]
        api(admin.request, "PATCH", f"admin/users/{profile['id']}", {"participantType": "INDIVIDUAL"})
        buyer_page.goto(f"{BASE}/listings/{listing_id}")
        expect(buyer_page.get_by_text("Автор принимает обращения только от компаний.")).to_be_visible()
        expect(buyer_page.get_by_role("button", name="Написать", exact=True)).to_have_count(0)
        api(admin.request, "PATCH", f"admin/users/{profile['id']}", {
            "participantType": "COMPANY", "companyName": profile["companyName"],
        })
        buyer_page.reload()
        expect(buyer_page.get_by_role("button", name="Написать", exact=True)).to_be_visible()
        chat = api(buyer.request, "POST", "chats", {"listingId": listing_id})
        buyer_msg = f"Добрый день, уточните наличие оборудования {TAG}."
        seller_msg = f"Здравствуйте, оборудование на складе {TAG}."
        api(buyer.request, "POST", f"chats/{chat['id']}/messages", {"body": buyer_msg})
        api(seller.request, "POST", f"chats/{chat['id']}/messages", {"body": seller_msg})
        review_text = f"Тестовый отзыв {TAG}"
        report_text = f"Описание обращения модератору {TAG}"
        api(buyer.request, "POST", f"chats/{chat['id']}/reviews", {"rating": 4, "comment": review_text})
        evidence = api(buyer.request, "POST", f"chats/{chat['id']}/reports", {"reason": "OTHER", "scope": "ON_PLATFORM", "details": report_text})

        section(page, "Отзывы")
        search(page, review_text)
        rating_count = api(buyer.request, "GET", f"listings/{listing_id}")["owner"]["ratingCount"]
        change_status(page, row(page, review_text), "Модерировать", "HIDDEN", f"Скрыть отзыв {TAG}")
        checked(api(buyer.request, "GET", f"listings/{listing_id}")["owner"]["ratingCount"] == rating_count - 1, "Hidden review still affects reputation")
        change_status(page, row(page, review_text), "Модерировать", "ACTIVE", f"Восстановить отзыв {TAG}")
        complete("Модерация отзывов с пересчётом рейтинга")

        section(page, "Жалобы")
        search(page, report_text)
        report_dialog = dialog_for(row(page, report_text), "Рассмотреть")
        report_dialog.get_by_role("button", name="Посмотреть переписку по жалобе").click()
        expect(report_dialog.get_by_text(buyer_msg, exact=True)).to_be_visible()
        expect(report_dialog.get_by_text(seller_msg, exact=True)).to_be_visible()
        report_dialog.get_by_label("Новый статус").select_option(value="RESOLVED")
        report_dialog.get_by_label("Причина").fill(f"Жалоба обработана {TAG}")
        report_dialog.get_by_role("button", name="Применить статус").click()
        saved(page)
        expect(row(page, report_text).get_by_text("Решена", exact=True)).to_be_visible()
        denied_evidence = buyer.request.get(f"{BASE}/api/v1/admin/reports/{evidence['id']}/messages")
        checked(denied_evidence.status == 403, "Ordinary member unexpectedly has access to admin evidence")
        complete("Рассмотрение жалобы и просмотр переписки с проверкой доступа")

        section(page, "Объявления")
        search(page, offer_title)
        dialog = dialog_for(row(page, offer_title), "Редактировать")
        expect(dialog.locator("input[name=title]")).to_have_value(offer_title)
        offer_title += " изменено"
        dialog.locator("input[name=title]").fill(offer_title)
        dialog.get_by_role("button", name="Сохранить", exact=False).click()
        saved(page)
        expect(row(page, offer_title)).to_be_visible()
        checked(api(buyer.request, "GET", f"listings/{listing_id}")["title"] == offer_title, "Edited offer not returned")
        change_status(page, row(page, offer_title), "Статус", "FROZEN", f"Тест заморозки {TAG}")
        checked(buyer.request.get(f"{BASE}/api/v1/listings/{listing_id}").status == 404, "Frozen listing remains public")
        change_status(page, row(page, offer_title), "Статус", "ACTIVE", f"Тест восстановления {TAG}")
        api(buyer.request, "GET", f"listings/{listing_id}")
        change_status(page, row(page, offer_title), "Статус", "BANNED", f"Тест блокировки {TAG}")
        expect(row(page, offer_title).get_by_text("Заблокирован навсегда")).to_be_visible()
        expect(row(page, offer_title).get_by_role("button", name="Статус", exact=True)).to_have_count(0)
        complete("Редактирование и все статусы модерации объявления")

        section(page, "Языки")
        page.get_by_role("button", name="Добавить язык").click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("Название языка").fill("English")
        dialog.get_by_label("Код языка", exact=False).fill("en")
        dictionary = {"Администрирование": "Administration QA"}
        dialog.get_by_label("Переводы интерфейса", exact=False).fill(json.dumps(dictionary, ensure_ascii=False))
        dialog.get_by_label("Включить в переключателе языков").check()
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        locale = page.get_by_role("combobox", name="Язык интерфейса")
        locale.select_option("en")
        heading(page, "Administration QA")
        locale.select_option("ru")
        heading(page, "Администрирование")
        complete("Добавление языка, сохранение перевода и переключение интерфейса")

        section(page, "Категории")
        translated_name = "Test category " + TAG
        api(admin.request, "PATCH", f"admin/categories/{category_id}", {"translations": {"en": {"name": translated_name}}})
        guest_page.reload()
        guest_locale = guest_page.get_by_role("combobox", name="Язык интерфейса")
        guest_locale.select_option("en")
        expect(first_tile).to_have_text(translated_name)
        guest_locale.select_option("ru")
        dialog = dialog_for(row(page, category_name), "Редактировать")
        dialog.get_by_label("Показывать в каталоге").uncheck()
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        checked(not any(item["id"] == category_id for item in api(guest.request, "GET", "categories")), "Hidden category remains public")
        complete("Перевод и скрытие категории")

        section(page, "Страницы")
        page.get_by_role("button", name="Добавить страницу").click()
        dialog = page.get_by_role("dialog")
        content_key = "test-" + TAG
        content_title = "constructor"
        dialog.get_by_label("Адрес страницы", exact=False).fill(content_key)
        ru = dialog.get_by_role("group", name="Русский")
        ru.get_by_label("Заголовок").fill(content_title)
        ru.get_by_label("Текст страницы").fill("Проверка публичной страницы, настроенной через панель управления.")
        dialog.get_by_label("Опубликовать страницу").check()
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        guest_page.goto(f"{BASE}/info/{content_key}")
        heading(guest_page, content_title)
        dialog = dialog_for(row(page, content_title), "Редактировать")
        dialog.get_by_label("Опубликовать страницу").uncheck()
        dialog.get_by_role("button", name="Сохранить", exact=True).click()
        saved(page)
        guest_page.reload()
        expect(guest_page.get_by_text("Страница не найдена.", exact=True)).to_be_visible()
        complete("Публикация, чтение и скрытие страницы")

        section(page, "Пользователи")
        search(page, "test1")
        change_status(page, row(page, "test1"), "Статус", "BANNED", f"Тест блокировки профиля {TAG}")
        expect(row(page, "test1").get_by_text("Заблокирован навсегда")).to_be_visible()
        expect(row(page, "test1").get_by_role("button", name="Статус", exact=True)).to_have_count(0)
        checked(api(seller.request, "GET", "auth/me")["user"] is None, "Banned profile retained its session")
        banned_login = seller.request.post(f"{BASE}/api/v1/auth/login", data={"login": "test1", "password": "test1"})
        checked(banned_login.status == 403, "Banned profile can sign in")
        complete("Бессрочная блокировка профиля и отзыв сессии")

        for name in ["Отзывы", "Жалобы", "Журнал действий"]:
            section(page, name)
            expect(page.get_by_text(re.compile(r"Всего записей"))).to_be_visible()
        grid = page.locator(".admin-table")
        expect(grid).to_be_visible()
        expect(grid.get_by_text(f"Тест блокировки {TAG}").first).to_be_visible()
        expect(grid.get_by_text("Просмотр переписки по жалобе", exact=True)).to_be_visible()
        grid.get_by_text("Подробнее", exact=True).first.click()
        expect(grid.locator("pre").first).to_be_visible()
        complete("Разделы отзывов, жалоб и журнала с деталями")

        for width in [1420, 1024, 768, 390, 320]:
            verify_width(page, width)
        page.get_by_role("button", name="Открыть меню", exact=True).click()
        expect(locale).to_be_visible()
        locale.select_option("en")
        heading(page, "Administration QA")
        verify_width(page, 320)
        locale.select_option("ru")
        page.get_by_role("button", name="Закрыть меню", exact=True).click()
        section(page, "Категории")
        dialog = dialog_for(row(page, category_name), "Редактировать")
        checked(dialog.evaluate("(node) => node.getBoundingClientRect().width < window.innerWidth"), "Mobile form exceeds viewport")
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        checked(not errors, "\n".join(errors))
        complete("Адаптивность от 320 до 1420 px и клавиатурное закрытие")
        browser.close()


if __name__ == "__main__":
    main()
