"""Exercise v3 invited entry, in-chat documents and operator drafts on a disposable demo."""

import os
from secrets import token_hex

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import BASE, button, check_no_overflow, complete_otp, field, heading
from contextual_moderation_e2e import activate_staff, api, login

PDF = {"name": "balance.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"}
EXCHANGE = "/admin?section=exchange&part="


def configure(admin):
    settings = {
        "feature_invites": True, "registration_mode": "INVITE", "feature_trust_rating": True,
        "feature_disclosure_journal": True, "disclosure_min_level": 1, "feature_listing_premoderation": True,
        "feature_lot_groups": False, "disclosure_requires_verified_telegram": False,
    }
    for key, value in settings.items():
        api(admin, "admin/settings/" + key, "PUT", {"value": value})


def onboard_seller(page, invitation, category):
    username = "onboardui" + token_hex(4)
    email = username + "@example.test"
    page.goto(BASE + "/register?invite=" + invitation["code"])
    expect(page.get_by_text("Шаг 1 из 4", exact=True)).to_be_visible()
    for key, value in {"username": username, "email": email, "city": "Москва", "telegram": username,
                       "password": "Focus-Account-E2E-2026!"}.items():
        field(page, key).fill(value)
    field(page, "role").select_option("SELLER")
    page.locator('input[name="pdConsent"]').check()
    page.locator("altcha-widget").get_by_role("checkbox").press("Space")
    expect(button(page, "Получить код")).to_be_enabled()
    button(page, "Получить код").click()
    expect(page.get_by_text("Шаг 2 из 4", exact=True)).to_be_visible()
    complete_otp(page, email)
    expect(page.get_by_text("Шаг 3 из 4", exact=True)).to_be_visible()
    optional = page.get_by_text("Ответить подробнее (по желанию)", exact=True)
    expect(optional).to_be_visible()
    expect(field(page, "seller_01")).not_to_be_visible()
    for key in ("seller_02", "seller_03", "seller_06"):
        field(page, key).fill("Работаю с закупками оборудования и поставками")
    page.locator(".onboarding-check input").check()
    button(page, "Отправить анкету").click()
    expect(page.get_by_text("Шаг 4 из 4", exact=True)).to_be_visible()
    expect(heading(page, "Разместите первое объявление")).to_be_visible()
    assert not page.locator('input[type="file"]').count()
    check_no_overflow(page)
    page.get_by_role("link", name="Разместить", exact=True).click()
    field(page, "categoryId").select_option(category)
    field(page, "modelId").select_option("h100-sxm")
    field(page, "stockCity").fill("Москва")
    field(page, "price").fill("10000")
    expect(field(page, "description")).not_to_be_visible()
    check_no_overflow(page)
    button(page, "Опубликовать объявление").click()
    expect(page.get_by_role("heading", name="Продам H100", exact=False).first).to_be_visible()
    expect(page.get_by_text("Проверен оператором", exact=True)).to_be_visible()
    return page.url.rsplit("/", 1)[1]


def docs_in_chat(seller, buyer, moderator, listing_id):
    chat = api(buyer, "chats", "POST", {"listingId": listing_id})
    path = f'chats/{chat["id"]}/reveal'
    api(seller, path, "PATCH", {"action": "REQUEST", "rulesAccepted": True})
    page = buyer.new_page()
    page.goto(BASE + "/chats/" + chat["id"])
    summary = page.get_by_text("Чтобы открыть контакты, загрузите 2 документа (около 5 минут)", exact=True)
    expect(summary).to_be_visible()
    composer = page.locator("#chat-message-input")
    expect(composer).to_be_in_viewport(ratio=0.98)
    summary.press("Enter")
    check_no_overflow(page)
    for label in ("Карточка компании", "Кто подписывает"):
        upload = page.locator(".chat-verification form").filter(has_text=label)
        upload.locator('input[type="file"]').set_input_files(PDF)
        button(upload, "Загрузить").click()
        expect(page.get_by_text(label + " · На проверке", exact=True)).to_be_visible()
    expect(button(page, "Документы на проверке")).to_be_disabled()
    user = api(buyer, "auth/me")["user"]
    for document in api(buyer, "documents"):
        api(moderator, f'admin/documents/{document["id"]}/approve', "POST", {})
    api(moderator, f'admin/users/{user["id"]}/verify', "POST", {"level": 1})
    page.reload()
    page.get_by_text("Прочитать правила раскрытия", exact=True).click()
    page.get_by_role("checkbox", name="Понимаю правила раскрытия").check()
    button(page, "Согласиться").click()
    expect(page.get_by_text("Telegram открыт для обоих", exact=True)).to_be_visible()
    check_no_overflow(page)


def operator_draft(moderator, seller, category):
    owner = api(seller, "auth/me")["user"]
    page = moderator.new_page()
    page.goto(BASE + "/admin/users/" + owner["id"] + "/listing/new")
    expect(heading(page, "Завести объявление за участника")).to_be_visible()
    values = {"staffSourceNote": "Записано с разрешения поставщика", "title": "Черновик модератора",
              "description": "Отдельная карточка с подтверждением через браузер.", "stockCity": "Москва", "price": "10000"}
    for key, value in values.items():
        field(page, key).fill(value)
    field(page, "categoryId").select_option(category)
    field(page, "modelId").select_option("h100-sxm")
    check_no_overflow(page)
    button(page, "Отправить черновик владельцу").click()
    expect(heading(page, "Черновик модератора")).to_be_visible()
    expect(page.get_by_text("Ждёт подтверждения владельца", exact=True)).to_be_visible()
    listing_id = page.url.rsplit("/", 1)[1]
    notifications = api(seller, "notifications")["items"]
    notice = next(value for value in notifications if value["kind"] == "listing.owner_confirm"
                  and value["payload"]["listingId"] == listing_id)
    action = next(value["href"] for value in notice["actions"] if value["label"] == "Подтверждаю, публиковать")
    owner_page = seller.new_page()
    owner_page.set_viewport_size({"width": 1280, "height": 900})
    owner_page.goto(BASE + action)
    confirm = button(owner_page, "Подтверждаю, публиковать")
    expect(confirm).to_be_visible()
    confirm.focus()
    owner_page.keyboard.press("Enter")
    expect(confirm).not_to_be_visible()
    assert api(seller, "listings/" + listing_id)["status"] == "ACTIVE"
    check_no_overflow(owner_page)


def run(browser):
    admin = browser.new_context(viewport={"width": 1280, "height": 900})
    moderator = browser.new_context(viewport={"width": 1280, "height": 900})
    seller = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
    buyer = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
    activate_staff(admin, moderator)
    configure(admin)
    staff_page = moderator.new_page()
    staff_page.goto(BASE + EXCHANGE + "invites")
    expect(heading(staff_page, "Создать приглашения")).to_be_visible()
    expect(staff_page.get_by_role("checkbox", name="Знаю лично")).to_have_count(0)
    check_no_overflow(staff_page)
    invitation = api(admin, "admin/invites", "POST", {
        "count": 1, "knownPersonally": True, "note": "Поставщик знаком лично", "presetRole": "SELLER"
    })["items"][0]
    login(buyer, "test2", "test2")
    category = next(item["id"] for item in api(buyer, "categories") if item["slug"] == "gpu")
    listing = onboard_seller(seller.new_page(), invitation, category)
    print("PASS four invited entry screens, compact first listing and separate operator verification label")
    docs_in_chat(seller, buyer, moderator, listing)
    print("PASS buyer 375 px sees composer and completes both disclosures from chat")
    operator_draft(moderator, seller, category)
    print("PASS moderator draft, owner keyboard approval at 1280 px")


if __name__ == "__main__":
    expect.set_options(timeout=30000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH") or None,
                                             headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            run(browser)
        finally:
            browser.close()
