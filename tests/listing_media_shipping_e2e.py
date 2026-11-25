"""Browser coverage of listing photo editing and flexible shipping origin.

Run only on a fresh disposable demo database. This script rotates the admin
credentials and creates three listings. Set HWFORAI_MEDIA_QA_URL to the app.
Optionally set CHROMIUM_PATH and HWFORAI_MEDIA_QA_SCREENSHOTS.
"""

import os
import re
import struct
import tempfile
import zlib
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from country_controls import choose_country

BASE = os.getenv("HWFORAI_MEDIA_QA_URL", "http://127.0.0.1:3000").rstrip("/")
CHROMIUM = os.getenv("CHROMIUM_PATH")
SCREENSHOTS = os.getenv("HWFORAI_MEDIA_QA_SCREENSHOTS")
TAG = uuid4().hex[:8]


def png(width, height, color):
    """Generate a deterministic raster fixture without an image library."""
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raster = (b"\0" + bytes(color) * width) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raster)) + chunk(b"IEND", b"")


def field(scope, name):
    return scope.locator(f'input[name="{name}"], textarea[name="{name}"], select[name="{name}"]')


def button(scope, label):
    return scope.get_by_role("button", name=label, exact=True)


def screenshot(page, file_name):
    if SCREENSHOTS:
        directory = Path(SCREENSHOTS)
        directory.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=directory / file_name, full_page=True)


def check_narrow_photo_layout(page):
    previous = page.viewport_size
    page.set_viewport_size({"width": 320, "height": 780})
    scroll_width = page.evaluate("document.documentElement.scrollWidth")
    assert scroll_width <= 320, f"{page.url} scroll width is {scroll_width}px"
    page.set_viewport_size(previous)


def login(page, user, password=None, next_path=None):
    query = "?" + urlencode({"next": next_path}) if next_path else ""
    page.goto("/login" + query)
    field(page, "login").fill(user)
    field(page, "password").fill(password or user)
    with page.expect_response(lambda response: response.url.endswith("/api/v1/auth/login")) as pending:
        button(page, "Войти").click()
    response = pending.value
    assert response.ok and response.json().get("user"), response.text()


def fill_listing(page, title, source, paths=(), buyer=False):
    page.goto("/listings/new")
    expect(page.get_by_role("heading", name="Новое объявление")).to_be_visible()
    field(page, "title").fill(title)
    field(page, "categoryId").select_option(index=1)
    field(page, "description").fill("Тестовое объявление для проверки фотографий и географии поставки.")
    field(page, "priceMode").select_option("NEGOTIABLE")
    if buyer:
        field(page, "originScope").select_option("ANY")
        expect(field(page, "originCountry")).to_have_count(0)
        choose_country(page, "destinationCountry", "RU")
        field(page, "deliveryBy").fill((date.today() + timedelta(days=30)).isoformat())
    else:
        field(page, "availability").select_option("STOCK")
        field(page, "stockCity").fill("Новосибирск")
        choose_country(page, "originCountry", source)
    if paths:
        expect(field(page, "listingImages")).to_have_count(1)
        expect(field(page, "listingImages")).to_be_hidden()
        with page.expect_file_chooser() as pending:
            button(page, "Добавить фото").click()
        pending.value.set_files(paths)
        expect(button(page, f"Удалить фото {min(len(paths), 10)}")).to_be_visible()
    if len(paths) > 10:
        expect(page.get_by_text("К объявлению можно прикрепить до 10 фото.", exact=True)).to_be_visible()
        expect(button(page, "Удалить фото 11")).to_have_count(0)
        expect(button(page, "Добавить фото")).to_be_disabled()
        check_narrow_photo_layout(page)
        screenshot(page, "seller-ten-images.png")
    with page.expect_response(lambda response: response.url.endswith("/api/v1/listings")
                              and response.request.method == "POST") as pending:
        button(page, "Опубликовать объявление").click()
    assert pending.value.ok, pending.value.text()
    page.wait_for_url(re.compile(r"/listings/[a-f0-9-]{36}$"))
    return pending.value.json()["id"]


def detail(context, listing_id):
    response = context.request.get(f"/api/v1/listings/{listing_id}")
    assert response.ok, response.text()
    return response.json()


def activate_admin(page):
    login(page, "admin", next_path="/admin")
    page.wait_for_url("**/account")
    field(page, "username").fill(f"media-admin-{TAG}")
    field(page, "currentPassword").fill("admin")
    field(page, "newPassword").fill("Media-QA-Fixture-2026")
    field(page, "confirmPassword").fill("Media-QA-Fixture-2026")
    with page.expect_response(lambda response: response.url.endswith("/api/v1/auth/credentials")
                              and response.request.method == "PATCH") as pending:
        button(page, "Обновить данные для входа").click()
    assert pending.value.ok, pending.value.text()
    page.wait_for_url("**/admin")
    expect(page.get_by_role("heading", name="Администрирование")).to_be_visible(timeout=15000)


def main():
    with tempfile.TemporaryDirectory(prefix="hwforai-images-") as temporary, sync_playwright() as playwright:
        files = []
        for index in range(11):
            fixture = Path(temporary) / f"fixture-{index + 1}.png"
            size = (1260, 840) if index == 0 else (840, 1260) if index == 1 else (240, 180)
            fixture.write_bytes(png(*size, (index * 19, 255 - index * 17, 90)))
            files.append(fixture)

        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=["--no-sandbox"])
        seller = browser.new_context(base_url=BASE, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        buyer = browser.new_context(base_url=BASE, viewport={"width": 1360, "height": 900})
        admin = browser.new_context(base_url=BASE, viewport={"width": 1360, "height": 900})
        guest = browser.new_context(base_url=BASE)
        seller_page, buyer_page, admin_page = [context.new_page() for context in (seller, buyer, admin)]
        errors = []
        for page in (seller_page, buyer_page, admin_page):
            page.on("pageerror", lambda error: errors.append(str(error)))

        login(seller_page, "test1")
        any_title = f"Сервер для поставки из любой страны {TAG}"
        specific_title = f"Сервер со склада в России {TAG}"
        listing_id = fill_listing(seller_page, any_title, "ANY", files)
        listing = detail(seller, listing_id)
        assert listing["originScope"] == "ANY" and listing["originCountry"] is None, listing
        assert listing["stockCity"] == "Новосибирск"
        photos = listing["images"]
        assert len(photos) == 10, photos
        assert len({photo["id"] for photo in photos}) == 10
        assert (photos[0]["width"], photos[0]["height"]) == (900, 600), photos[0]
        assert (photos[1]["width"], photos[1]["height"]) == (600, 900), photos[1]
        photo_url = photos[0]["url"]
        assert guest.request.get(photo_url).status == 401
        assert seller_page.evaluate("document.documentElement.scrollWidth") <= 390
        fill_listing(seller_page, specific_title, "RU")
        print("PASS seller creates offers with ten optimized photos, any-country shipping, and specific-country shipping", flush=True)

        login(buyer_page, "test2")
        buyer_page.goto("/catalog?" + urlencode({"q": TAG}))
        flexible_card = buyer_page.get_by_role("link").filter(has_text=any_title)
        specific_card = buyer_page.get_by_role("link").filter(has_text=specific_title)
        expect(flexible_card).to_be_visible()
        expect(specific_card).to_be_visible()
        cover = flexible_card.locator("img")
        expect(cover).to_have_attribute("src", photo_url)

        def filter_country(country):
            def listing_search(response):
                url = urlsplit(response.url)
                return url.path == "/api/v1/listings" and parse_qs(url.query).get("country") == [country]

            with buyer_page.expect_response(listing_search) as pending:
                choose_country(buyer_page, "originCountry", country)
            assert pending.value.ok, pending.value.text()

        filter_country("ANY")
        expect(flexible_card).to_be_visible()
        expect(specific_card).to_have_count(0)
        filter_country("KZ")
        expect(flexible_card).to_be_visible()
        expect(specific_card).to_have_count(0)
        filter_country("RU")
        expect(flexible_card).to_be_visible()
        expect(specific_card).to_be_visible()
        flexible_card.click()
        gallery = buyer_page.get_by_role("region", name="Фотографии объявления")
        expect(gallery).to_be_visible()
        button(gallery, "Показать фото 2").click()
        expect(gallery.get_by_role("link", name="Открыть фото в полном размере")).to_have_attribute("href", photos[1]["url"])
        downloaded = buyer.request.get(photo_url)
        assert downloaded.ok and downloaded.headers["content-type"] == "image/webp", downloaded.status
        assert downloaded.body().startswith(b"RIFF") and downloaded.body()[8:12] == b"WEBP"
        check_narrow_photo_layout(buyer_page)
        screenshot(buyer_page, "buyer-gallery.png")
        print("PASS buyer sees the cover and gallery, and the any-country offer matches compatible search filters", flush=True)

        seller_page.goto(f"/listings/{listing_id}/edit")
        button(seller_page, "Сделать фото 2 обложкой").click()
        button(seller_page, "Удалить фото 10").click()
        button(seller_page, "Сохранить изменения").click()
        seller_page.wait_for_url(f"**/listings/{listing_id}")
        revised = detail(seller, listing_id)["images"]
        assert len(revised) == 9 and revised[0]["id"] == photos[1]["id"], revised
        assert buyer.request.get(photos[-1]["url"]).status == 404
        buyer_page.goto(f"/listings/{listing_id}")
        expect(buyer_page.get_by_role("link", name="Открыть фото в полном размере")).to_have_attribute("href", revised[0]["url"])
        request_id = fill_listing(buyer_page, f"Куплю сервер с фото {TAG}", None, files[:1], buyer=True)
        assert len(detail(seller, request_id)["images"]) == 1
        print("PASS both roles can attach photos, and replacing the cover and removing a photo persist", flush=True)

        activate_admin(admin_page)
        admin_page.get_by_role("navigation", name="Разделы администрирования").get_by_role("link", name="Объявления", exact=True).click()
        admin_page.get_by_role("searchbox").fill(any_title)
        button(admin_page, "Найти").click()
        item = admin_page.get_by_role("row").filter(has_text=any_title)
        button(item, "Редактировать").click()
        dialog = admin_page.get_by_role("dialog")
        button(dialog, "Удалить фото 9").click()
        button(dialog, "Сохранить изменения").click()
        expect(dialog).not_to_be_visible()
        remaining = detail(buyer, listing_id)["images"]
        assert len(remaining) == 8 and remaining[0]["id"] == revised[0]["id"]
        button(item, "Статус").click()
        dialog.get_by_label("Новый статус").select_option("FROZEN")
        dialog.get_by_label("Причина").fill("Проверка доступа к изображениям скрытого объявления.")
        button(dialog, "Применить статус").click()
        expect(dialog).not_to_be_visible()
        assert buyer.request.get(remaining[0]["url"]).status == 404
        assert admin.request.get(remaining[0]["url"]).ok
        assert not errors, errors
        print("PASS administrator can edit photos and moderation protects their URLs; no browser runtime errors", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
