"""Smoke the privacy transition and v2 staff navigation against a disposable maxv demo."""

import os
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

from contextual_moderation_e2e import BASE, activate_staff, api, login, publish

CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
EXCHANGE = '/admin?section=exchange&part='
FAKE_PHONE = '+1 (202) 555-0147'


def button(parent, name):
    return parent.get_by_role('button', name=name, exact=True)


def assert_fit(page):
    layout = page.evaluate('({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})')
    assert layout['scrollWidth'] <= layout['width'], (page.url, layout)


def check_registration(page):
    page.goto(BASE + '/register')
    expect(page.get_by_role('heading', name='Регистрация', exact=True)).to_be_visible()
    consent = page.locator('input[name="pdConsent"]')
    expect(consent).not_to_be_checked()
    expect(button(page, 'Получить код')).to_be_disabled()
    consent.focus()
    page.keyboard.press('Space')
    expect(consent).to_be_checked()
    expect(page.get_by_role('link', name='Политика обработки персональных данных', exact=True)).to_have_attribute('target', '_blank')
    assert_fit(page)
    print('PASS mobile signup consent, keyboard, submit guard and policy link', flush=True)


def check_live_consent(page, admin, seller, buyer):
    category = next(row['id'] for row in api(seller, 'categories') if row['slug'] == 'gpu')
    listing_id = publish(seller, category, 'NVIDIA L40S для контура пробы', 'SELL')
    chat_id = api(buyer, 'chats', 'POST', {'listingId': listing_id})['id']
    chat_path = f'/chats/{chat_id}'
    page.goto(BASE + chat_path)
    composer = page.locator('#chat-message-input')
    expect(composer).to_be_visible()
    prior_version = api(buyer, 'auth/me')['user']['pdPolicyVersion']
    version = '0.2' if prior_version != '0.2' else '0.3'
    api(admin, 'admin/settings/pd_policy_version', 'PUT', {'value': version})
    blocked_text = 'Это сообщение до принятия новой политики'
    composer.fill(blocked_text)
    button(page, 'Отправить').click()
    expect(page.get_by_role('heading', name='Политика обработки персональных данных', exact=True)).to_be_visible()
    assert urlsplit(page.url).path == '/consent'
    assert parse_qs(urlsplit(page.url).query)['next'] == [chat_path]
    expect(button(page, 'Принять')).to_be_disabled()
    expect(page.get_by_text(f'Политика обработки персональных данных обновилась (версия {version}).')).to_be_visible()
    assert_fit(page)
    page.locator('input[name="pdConsent"]').check()
    button(page, 'Принять').click()
    expect(page).to_have_url(BASE + chat_path)
    expect(composer).to_be_visible()
    expect(page.get_by_text(blocked_text, exact=True)).to_have_count(0)
    assert api(buyer, 'auth/me')['user']['pdConsentRequired'] is False

    composer.fill(FAKE_PHONE)
    button(page, 'Отправить').click()
    expect(page.get_by_role('alert').get_by_text('Контакты', exact=False).first).to_be_visible()
    expect(composer).to_have_value(FAKE_PHONE)
    assert FAKE_PHONE not in repr(api(seller, f'chats/{chat_id}/messages'))
    assert_fit(page)
    print('PASS live tab reconsent, original route restored, chat draft retained and hidden from peer', flush=True)


def check_staff(page, role):
    staff_common = {
        'pilot': 'Показатели пробы', 'lots': 'Дубли лотов', 'matching': 'Совпадения',
    }
    administrator = {
        'contact-blocks': 'Попытки обхода', 'data-requests': 'Запросы по данным', 'telegram': 'Telegram',
    }
    for section, link in (staff_common | administrator if role == 'ADMIN' else staff_common).items():
        page.goto(BASE + EXCHANGE + section)
        nav = page.get_by_role('navigation', name='Управление биржей', exact=True)
        expect(nav.get_by_role('link', name=link, exact=True)).to_have_attribute('aria-current', 'page')
        if role == 'MODERATOR':
            for name in administrator.values():
                expect(nav.get_by_role('link', name=name, exact=True)).to_have_count(0)
        assert_fit(page)
    print(f'PASS {role} staff routing and layout at {page.viewport_size["width"]} px', flush=True)


def run(browser):
    admin = browser.new_context(viewport={'width': 1440, 'height': 1000})
    moderator = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    buyer = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    seller = browser.new_context()
    activate_staff(admin, moderator)
    check_registration(buyer.new_page())
    for context, username in ((buyer, 'test2'), (seller, 'test1')):
        login(context, username, username)
    api(admin, 'admin/settings/feature_disclosure_journal', 'PUT', {'value': True})
    check_live_consent(buyer.new_page(), admin, seller, buyer)
    check_staff(admin.new_page(), 'ADMIN')
    check_staff(moderator.new_page(), 'MODERATOR')


if __name__ == '__main__':
    expect.set_options(timeout=45000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            run(browser)
        finally:
            browser.close()
