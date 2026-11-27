"""Repeat deals and dual-side account controls on a disposable demo."""

import os
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from chat_e2e import API, BASE_URL, external_overflow, login, response_json, start_chat


def provision_seller(context, title):
    gpu = next(row for row in response_json(context.request.get(API + '/categories')) if row['slug'] == 'gpu')
    return response_json(context.request.post(API + '/listings', data={
        'title': title, 'description': 'Тестовая поставка по независимому объявлению.',
        'categoryId': gpu['id'], 'modelId': 'h100-sxm', 'kind': 'SELL', 'quantity': 2, 'condition': 'NEW',
        'priceMode': 'NEGOTIABLE', 'availability': 'STOCK', 'originCountry': 'RU', 'stockCity': 'Москва',
    }))


def set_settings(context):
    response_json(context.request.post(API + '/auth/login', data={'login': 'admin', 'password': 'admin'}))
    me = response_json(context.request.get(API + '/auth/me'))['user']
    if me['mustChangePassword']:
        response_json(context.request.patch(API + '/auth/credentials', data={
            'currentPassword': 'admin', 'newPassword': 'Deals-UI-2026-Test-Admin!',
        }))
    for setting, value in [('feature_disclosure_journal', True), ('feature_trust_rating', True),
                           ('disclosure_min_level', 0), ('disclosure_requires_verified_telegram', False)]:
        response_json(context.request.put(API + '/admin/settings/' + setting, data={'value': value}))


def finish_new_side(context, page):
    page.goto('/account')
    side_settings = page.get_by_role('region', name='Покупка и продажа')
    expect(side_settings.get_by_role('checkbox', name='Покупаю')).to_be_checked()
    side_settings.get_by_role('checkbox', name='Продаю').check()
    side_settings.get_by_role('button', name='Сохранить стороны').click()
    page.wait_for_url('**/onboarding')
    onboarding = response_json(context.request.get(API + '/onboarding'))
    assert [group['key'] for group in onboarding['groups']] == ['seller']
    required = [q['id'] for q in onboarding['groups'][0]['questions'] if q['required']]
    assert len(required) == 3
    response_json(context.request.put(API + '/onboarding', data={
        'answers': {key: 'Проверяем вторую сторону аккаунта' for key in required},
        'rulesVersion': onboarding['rulesVersion'], 'rulesAccepted': True, 'representationMode': 'DIRECT',
    }))


def run(browser):
    buyer = browser.new_context(base_url=BASE_URL, viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    seller = browser.new_context(base_url=BASE_URL, viewport={'width': 1280, 'height': 900})
    admin = browser.new_context(base_url=BASE_URL)
    errors = []
    try:
        seller_page, _ = login(seller, 'test1')
        buyer_page, _ = login(buyer, 'test2')
        for page in [seller_page, buyer_page]:
            page.on('pageerror', lambda error: errors.append(str(error)))
        finish_new_side(buyer, buyer_page)

        buyer_page.goto('/listings/new')
        picker = buyer_page.get_by_label('Что размещаете?')
        expect(picker).to_be_visible()
        picker.select_option('BUY')
        expect(buyer_page.get_by_role('heading', name='Какое оборудование нужно')).to_be_visible()
        picker.select_option('SELL')
        expect(buyer_page.get_by_role('heading', name='Какое оборудование продаётся')).to_be_visible()
        assert external_overflow(buyer_page) == 0

        buyer_page.goto('/catalog')
        tabs = buyer_page.get_by_role('group', name='Тип объявления')
        tabs.get_by_role('button', name='Заявки', exact=True).click()
        expect(tabs.get_by_role('button', name='Заявки', exact=True)).to_have_attribute('aria-pressed', 'true')
        tabs.get_by_role('button', name='Предложения', exact=True).click()
        expect(tabs.get_by_role('button', name='Предложения', exact=True)).to_have_attribute('aria-pressed', 'true')
        assert external_overflow(buyer_page) == 0
        buyer_page.goto('/my-listings')
        own = buyer_page.get_by_role('navigation', name='Виды моих объявлений')
        own.get_by_role('button', name='Заявки').click()
        expect(own.get_by_role('button', name='Заявки')).to_have_attribute('aria-pressed', 'true')

        tag = uuid4().hex[:6]
        first = provision_seller(seller, f'H100 первая поставка {tag}')
        second = provision_seller(seller, f'H100 повторная поставка {tag}')
        set_settings(admin)
        first_chat = response_json(buyer.request.post(API + '/chats', data={'listingId': first['id']}))
        invitation = response_json(buyer.request.patch(API + f"/chats/{first_chat['id']}/reveal", data={
            'action': 'REQUEST', 'rulesAccepted': True,
        }))
        response_json(seller.request.patch(API + f"/chats/{first_chat['id']}/reveal", data={
            'action': 'ACCEPT', 'requestId': invitation['revealRequestId'], 'rulesAccepted': True,
        }))
        second_chat = start_chat(buyer_page, second['id'])
        start = buyer_page.get_by_role('button', name='Начать сделку по этому объявлению', exact=True)
        expect(start).to_be_visible()
        start.focus()
        buyer_page.keyboard.press('Enter')
        panel = buyer_page.get_by_role('region', name='Сделка по этому объявлению')
        expect(panel.get_by_text('Идут переговоры', exact=True)).to_be_visible(timeout=12000)
        panel.get_by_role('button', name='Изменить статус сделки').click()
        expect(panel.get_by_label('Статус сделки')).to_be_visible()
        assert external_overflow(buyer_page) == 0

        seller_page.goto('/chats/' + second_chat)
        expect(seller_page.get_by_role('region', name='Сделка по этому объявлению')).to_be_visible()
        assert external_overflow(seller_page) == 0
        buyer_page.goto('/deals')
        expect(buyer_page.get_by_role('link', name=first['title'])).to_be_visible()
        expect(buyer_page.get_by_role('link', name=second['title'])).to_be_visible()
        assert external_overflow(buyer_page) == 0
        assert not errors, errors
        print('PASS 375/1280px dual-side profile, form, tabs, pair consent reuse and manual deal status')
    finally:
        buyer.close()
        seller.close()
        admin.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_TEST_CHROMIUM'),
            headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'],
        )
        try:
            run(browser)
        finally:
            browser.close()
