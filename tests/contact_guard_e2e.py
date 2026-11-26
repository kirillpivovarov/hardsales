"""Browser checks for contact blocking, focus recovery and administrator history."""

import os
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from chat_e2e import API, BASE_URL, login, publish_listing, response_json, send, start_chat
from listing_media_shipping_e2e import png


def run(browser):
    seller = browser.new_context(base_url=BASE_URL, viewport={'width': 1440, 'height': 1000})
    buyer = browser.new_context(base_url=BASE_URL, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    admin = browser.new_context(base_url=BASE_URL, viewport={'width': 1440, 'height': 1000})
    admin_name = os.environ.get('HWFORAI_CONTEXT_ADMIN_USERNAME', 'admin')
    admin_password = os.environ.get('HWFORAI_CONTEXT_ADMIN_PASSWORD', 'admin')
    auth = response_json(admin.request.post(f'{API}/auth/login', data={'login': admin_name, 'password': admin_password}))
    if auth['user']['mustChangePassword']:
        response_json(admin.request.patch(f'{API}/auth/credentials', data={
            'currentPassword': admin_password, 'newPassword': 'Contact-Guard-Browser-2026!',
        }))
    for flag, value in {'feature_disclosure_journal': True, 'feature_trust_rating': False,
                        'feature_actuality': False, 'disclosure_min_level': 0}.items():
        response_json(admin.request.put(f'{API}/admin/settings/{flag}', data={'value': value}))

    mobile, buyer_user = login(buyer, 'test2')
    desktop, _ = login(seller, 'test1')
    listing = publish_listing(seller, 'Проверка контактов ' + uuid4().hex[:8])
    chat_id = start_chat(mobile, listing)
    desktop.goto(f'/chats/{chat_id}')
    expect(mobile.get_by_text('Телефоны, почта, ссылки и ники мессенджеров до взаимного согласия', exact=False)).to_be_visible()

    contact = 'Позвоните +7 900 123 45 67'
    composer = mobile.get_by_role('textbox', name='Сообщение', exact=True)
    composer.fill(contact)
    mobile.get_by_role('button', name='Отправить', exact=True).click()
    expect(composer).to_have_value(contact)
    expect(composer).to_have_attribute('aria-invalid', 'true')
    expect(mobile.get_by_role('alert')).to_contain_text('Контакты откроются после взаимного согласия')
    expect(desktop.locator('.chat-message-list')).not_to_contain_text(contact)

    history = admin.new_page()
    history.goto('/admin?section=exchange&part=contact-blocks&userId=' + buyer_user['id'])
    expect(history.get_by_role('heading', name='Попытки обхода')).to_be_visible()
    expect(history.get_by_text(contact, exact=True)).to_be_visible()
    expect(history.get_by_text(f'Чат {chat_id}', exact=True)).to_be_visible()

    mobile.get_by_role('link', name='Предложить обмен').click()
    agreement = mobile.get_by_role('checkbox', name='Понимаю правила раскрытия')
    expect(agreement).to_be_focused()
    agreement.check()
    mobile.get_by_role('button', name='Предложить обмен', exact=True).click()
    expect(desktop.get_by_text('Собеседник предлагает обменяться Telegram', exact=True)).to_be_visible(timeout=15000)
    desktop.get_by_role('checkbox', name='Понимаю правила раскрытия').check()
    desktop.get_by_role('button', name='Согласиться', exact=True).click()
    expect(mobile.get_by_text('Telegram открыт для обоих', exact=True)).to_be_visible(timeout=15000)
    expect(composer).to_have_value(contact)
    send(mobile, contact)
    expect(desktop.locator('.chat-message-list')).to_contain_text(contact, timeout=15000)

    desktop.goto('/account')
    city = desktop.locator('input[name=city]')
    city.fill('Москва, ivan собака mail точка ru')
    desktop.get_by_role('button', name='Сохранить профиль').click()
    expect(city).to_have_attribute('aria-invalid', 'true')
    expect(city).to_be_focused()
    expect(desktop.get_by_role('alert')).to_contain_text('Уберите контакты')

    desktop.goto(f'/listings/{listing}/edit')
    desktop.locator('input[name=listingImages]').set_input_files({
        'name': 'verification.png', 'mimeType': 'image/png', 'buffer': png(32, 32, (45, 90, 180)),
    })
    photo_ack = desktop.get_by_role('checkbox', name='На фото нет контактов')
    expect(photo_ack).not_to_be_checked()
    expect(photo_ack).to_have_attribute('required', '')
    photo_ack.check()
    desktop.get_by_role('button', name='Сохранить изменения').click()
    desktop.wait_for_url(f'**/listings/{listing}')
    mobile.goto(f'/listings/{listing}')
    mobile.get_by_role('button', name='Сообщить о контактах на фото').click()
    photo_report = mobile.get_by_role('dialog', name='Контакты на фото')
    expect(photo_report.get_by_role('heading', name='Контакты на фото')).to_be_visible()
    photo_report.get_by_role('button', name='Отправить жалобу').click()
    expect(mobile.get_by_role('button', name='Жалоба отправлена')).to_be_focused()

    for page in (mobile, desktop, history):
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), page.url
    print('PASS blocked message draft, contact history, keyboard reveal, addressed field errors, photo consent and report at 390/1440 px')


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('HWFORAI_TEST_CHROMIUM'), headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            run(browser)
        finally:
            browser.close()
