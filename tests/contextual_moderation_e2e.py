"""Exercise staff moderation from storefront pages on a disposable demo database."""

import os
from datetime import date, timedelta
from urllib.parse import urlencode
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import mail_code


BASE = os.environ.get('HWFORAI_QA_BASE', 'http://127.0.0.1:3000').rstrip('/')
CHROMIUM = os.environ.get('CHROMIUM_PATH') or os.environ.get('HWFORAI_QA_CHROMIUM')
TAG = uuid4().hex[:8]
PASSWORD = 'Staff-Context-QA-2026!'
TEMPORARY = 'Temporary-Context-QA-2026!'


def api(context, path, method='GET', data=None):
    params = {'data': data} if data is not None else {}
    response = context.request.fetch(f'{BASE}/api/v1/{path}', method=method, **params)
    assert response.ok, (response.status, path, response.text())
    return response.json() if response.status != 204 else None


def login(context, username, password):
    return api(context, 'auth/login', 'POST', {'login': username, 'password': password})


def activate_staff(admin, moderator):
    login_name = os.environ.get('HWFORAI_CONTEXT_ADMIN_USERNAME', 'admin')
    current_password = os.environ.get('HWFORAI_CONTEXT_ADMIN_PASSWORD', 'admin')
    admin_user = login(admin, login_name, current_password)['user']
    if admin_user['mustChangePassword']:
        api(admin, 'auth/credentials', 'PATCH', {'currentPassword': current_password, 'newPassword': PASSWORD})

    email = f'staff-{TAG}@example.test'
    username = f'staff-{TAG}'
    api(admin, 'admin/moderators', 'POST', {
        'username': username, 'displayName': 'Модератор тестирования', 'email': email, 'temporaryPassword': TEMPORARY,
    })
    challenge = login(moderator, username, TEMPORARY)
    user = api(moderator, 'auth/verify', 'POST', {'challengeId': challenge['challengeId'], 'code': mail_code(email)})['user']
    assert user['role'] == 'MODERATOR' and user['mustChangePassword']
    api(moderator, 'auth/password', 'POST', {'currentPassword': TEMPORARY, 'newPassword': PASSWORD})


def publish(context, category_id, title, kind):
    terms = {'availability': 'STOCK', 'stockCity': 'Москва', 'originCountry': 'RU'} if kind == 'SELL' else {
        'originScope': 'ANY', 'destinationCountry': 'RU', 'deliveryBy': (date.today() + timedelta(days=30)).isoformat(),
    }
    return api(context, 'listings', 'POST', {
        'title': title, 'description': 'Объявление для проверки контекстной модерации.', 'kind': kind,
        'categoryId': category_id, 'quantity': 1, 'condition': 'NEW', 'paymentMethods': ['BANK_TRANSFER'], **terms,
    })['id']


def button(parent, name):
    return parent.get_by_role('button', name=name, exact=True)


def dialog_for(page, action):
    button(page, action).click()
    dialog = page.get_by_role('dialog')
    expect(dialog).to_be_visible()
    return dialog


def expect_stayed(page, url):
    expect(page.get_by_role('dialog')).not_to_be_visible()
    expect(page).to_have_url(url)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), page.url


def set_listing_status(page, url, status):
    dialog = dialog_for(page, 'Модерировать объявление')
    button(dialog, 'Изменить статус').click()
    dialog.get_by_label('Новый статус').select_option(status)
    dialog.get_by_label('Причина').fill(f'Контекстная проверка {TAG}')
    button(dialog, 'Применить статус').click()
    expect_stayed(page, url)


def run(browser):
    admin = browser.new_context(viewport={'width': 1440, 'height': 900})
    moderator = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    seller = browser.new_context()
    buyer = browser.new_context()
    guest = browser.new_context()
    activate_staff(admin, moderator)
    login(seller, 'test1', 'test1')
    login(buyer, 'test2', 'test2')
    slug = f'context-{TAG}'
    category_name = f'Контекстная категория {TAG}'
    category = api(admin, 'admin/categories', 'POST', {'name': category_name, 'slug': slug, 'sortOrder': 0})
    offer = f'Серверный комплект {TAG}'
    offer_id = publish(seller, category['id'], offer, 'SELL')
    bid = f'Заявка на комплект {TAG}'
    publish(buyer, category['id'], bid, 'BUY')
    chat = api(buyer, 'chats', 'POST', {'listingId': offer_id})['id']
    api(buyer, f'chats/{chat}/messages', 'POST', {'body': 'Поставка в течение месяца возможна?'})
    api(seller, f'chats/{chat}/messages', 'POST', {'body': 'Оборудование есть в наличии.'})
    review = f'Оборудование было в наличии {TAG}'
    complaint = f'Описание проблемы с заказом {TAG}'
    api(buyer, f'chats/{chat}/reviews', 'POST', {'rating': 4, 'comment': review})
    api(buyer, f'chats/{chat}/reports', 'POST', {'reason': 'OTHER', 'scope': 'ON_PLATFORM', 'details': complaint})

    desktop = admin.new_page()
    errors = []
    desktop.on('pageerror', lambda error: errors.append(str(error)))
    filters = {'category': slug, 'q': TAG, 'sort': 'newest'}
    catalog = BASE + '/catalog?' + urlencode(filters) + '#catalog'
    desktop.goto(catalog)
    trigger_name = f'Модерировать объявление {offer}'
    trigger = button(desktop, trigger_name)
    trigger.scroll_into_view_if_needed()
    scroll = desktop.evaluate('window.scrollY')
    dialog_for(desktop, trigger_name).press('Escape')
    expect_stayed(desktop, catalog)
    expect(trigger).to_be_focused()
    assert abs(desktop.evaluate('window.scrollY') - scroll) < 5

    dialog = dialog_for(desktop, trigger_name)
    button(dialog, 'Редактировать').click()
    edited_offer = offer + ' уточнено'
    dialog.locator('input[name=title]').fill(edited_offer)
    button(dialog, 'Сохранить изменения').click()
    expect_stayed(desktop, catalog)
    expect(desktop.get_by_role('heading', name=edited_offer, exact=True)).to_be_visible()

    dialog = dialog_for(desktop, f'Редактировать категорию {category_name}')
    next_slug = slug + '-new'
    dialog.locator('input[name=slug]').fill(next_slug)
    button(dialog, 'Сохранить').click()
    filters['category'] = next_slug
    expect_stayed(desktop, BASE + '/catalog?' + urlencode(filters) + '#catalog')
    expect(desktop.get_by_role('heading', name=edited_offer, exact=True)).to_be_visible()
    print('PASS desktop admin contextual edits, category filter, scroll and keyboard focus', flush=True)

    mobile = moderator.new_page()
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    mobile.goto(f'{BASE}/catalog?kind=BUY&q={TAG}')
    expect(mobile.get_by_role('heading', name=bid, exact=True)).to_be_visible()
    detail_url = f'{BASE}/listings/{offer_id}'
    mobile.goto(detail_url)
    set_listing_status(mobile, detail_url, 'FROZEN')
    expect(mobile.get_by_text('Заморожено', exact=True)).to_be_visible()
    assert buyer.request.get(f'{BASE}/api/v1/listings/{offer_id}').status == 404
    set_listing_status(mobile, detail_url, 'ACTIVE')
    expect(mobile.get_by_text('Заморожено', exact=True)).to_have_count(0)
    dialog = dialog_for(mobile, 'Модерировать профиль')
    button(dialog, 'Редактировать').click()
    city = f'Тестовый город {TAG}'
    dialog.get_by_label('Город').fill(city)
    button(dialog, 'Сохранить').click()
    expect_stayed(mobile, detail_url)
    expect(mobile.locator('.profile-inline').get_by_text(city, exact=False)).to_be_visible()
    dialog = dialog_for(mobile, 'Модерировать профиль')
    button(dialog, 'Отзывы о профиле').click()
    expect(dialog.get_by_text(review, exact=False)).to_be_visible()
    button(dialog, 'К действиям профиля').click()
    button(dialog, 'Жалобы на профиль').click()
    expect(dialog.get_by_text(complaint, exact=False)).to_be_visible()
    dialog.press('Escape')
    expect_stayed(mobile, detail_url)
    print('PASS mobile moderator both catalog roles, listing status and observed author profile edit', flush=True)

    info_url = BASE + '/info/rules'
    mobile.goto(info_url)
    dialog = dialog_for(mobile, 'Редактировать страницу')
    new_title = f'Правила площадки {TAG}'
    dialog.locator('input[name="title.ru"]').fill(new_title)
    button(dialog, 'Сохранить').click()
    expect_stayed(mobile, info_url)
    expect(mobile.get_by_role('heading', name=new_title, exact=True)).to_be_visible()
    dialog_for(mobile, 'Редактировать язык интерфейса').press('Escape')
    expect_stayed(mobile, info_url)
    guest_page = guest.new_page()
    guest_page.goto(info_url)
    expect(guest_page.get_by_role('heading', name=new_title, exact=True)).to_be_visible()
    expect(button(guest_page, 'Редактировать страницу')).to_have_count(0)
    buyer_page = buyer.new_page()
    buyer_page.goto(detail_url)
    expect(buyer_page.get_by_role('heading', name=edited_offer, exact=True)).to_be_visible()
    expect(button(buyer_page, 'Модерировать объявление')).to_have_count(0)
    expect(button(buyer_page, 'Модерировать профиль')).to_have_count(0)
    assert not errors, errors
    print('PASS in-place content and locale dialogs, staff-only controls and ordinary visibility', flush=True)


if __name__ == '__main__':
    expect.set_options(timeout=15000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        try:
            run(browser)
        finally:
            browser.close()
