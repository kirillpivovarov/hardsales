import json
import os
import re
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get('HWFORAI_TEST_URL', 'http://127.0.0.1:3000').rstrip('/')
CHROMIUM = os.environ.get('HWFORAI_TEST_CHROMIUM')
API = '/api/v1'
ARTIFACTS = Path(os.environ.get('HWFORAI_TEST_ARTIFACTS', Path(__file__).resolve().parents[1] / 'work' / 'chat-qa'))


def response_json(response):
    assert response.ok, (response.status, response.url, response.text())
    return response.json()


def login(context, username):
    page = context.new_page()
    page.goto('/login')
    page.locator('input[name=login]').fill(username)
    page.locator('input[name=password]').fill(username)
    page.get_by_role('button', name='Войти', exact=True).click()
    page.wait_for_url(re.compile(fr'{re.escape(BASE_URL)}/(?:catalog)?$'))
    user = response_json(context.request.get(f'{API}/auth/me'))
    return page, user.get('user', user)


def send(page, message):
    page.get_by_role('textbox', name='Сообщение', exact=True).fill(message)
    page.get_by_role('button', name='Отправить', exact=True).click()
    expect(page.get_by_role('listitem').filter(has_text=message)).to_be_visible()


def external_overflow(page):
    return page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')


def run(browser):
    seller_context = browser.new_context(base_url=BASE_URL, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    buyer_context = browser.new_context(base_url=BASE_URL, viewport={'width': 1440, 'height': 1000})
    stranger_context = browser.new_context(base_url=BASE_URL)
    title = 'Тест переписки ' + datetime.now().strftime('%H%M%S%f')
    listing_id = None
    try:
        seller, seller_user = login(seller_context, 'test1')
        buyer, buyer_user = login(buyer_context, 'test2')
        browser_errors = []
        for page in [buyer, seller]:
            page.on('pageerror', lambda error: browser_errors.append(str(error)))

        categories = response_json(seller_context.request.get(f'{API}/categories'))
        category = next(category for category in categories if category['active'])
        listing = response_json(seller_context.request.post(f'{API}/listings', data={
            'title': title, 'description': 'Тестовое описание для проверки чата hwforai.',
            'kind': 'SELL', 'categoryId': category['id'], 'quantity': 2, 'condition': 'NEW',
            'availability': 'STOCK', 'stockCity': 'Москва', 'originCountry': 'RU',
            'priceMode': 'NEGOTIABLE', 'currency': 'RUB', 'paymentMethods': ['BANK_TRANSFER'],
        }))
        listing_id = listing['id']
        buyer.goto(f'/listings/{listing_id}')
        buyer.get_by_role('button', name='Написать', exact=True).click()
        buyer.wait_for_url('**/chats/*')
        chat_id = buyer.url.split('/')[-1]
        expect(buyer.get_by_role('heading', name='Сообщения', exact=True)).to_be_visible()
        expect(buyer.get_by_text('Telegram скрыт', exact=True)).to_be_visible()
        buyer_handle = buyer_user['telegram'].lstrip('@')
        seller_handle = seller_user['telegram'].lstrip('@')
        assert seller_handle not in json.dumps(response_json(buyer_context.request.get(f'{API}/chats/{chat_id}')))
        assert stranger_context.request.get(f'{API}/chats/{chat_id}').status in (401, 403)

        first = 'Здравствуйте! Подскажите условия поставки.'
        send(buyer, first)
        seller.goto('/chats')
        thread = seller.get_by_role('navigation', name='Список переписок').get_by_role('link').filter(has_text=title)
        unread = thread.get_by_label('Непрочитанных сообщений: 1')
        expect(unread).to_be_visible()
        thread.click()
        expect(seller.get_by_role('listitem').get_by_text(first, exact=True)).to_be_visible()
        expect(seller.get_by_role('link', name='Все сообщения', exact=True)).to_be_visible()
        assert external_overflow(seller) == 0
        print('PASS desktop chat creation, mobile inbox, unread message, and anonymous privacy')

        other_contact = 'Пишите @unlinked_purchase.'
        seller.get_by_role('textbox', name='Сообщение', exact=True).fill(other_contact)
        expect(seller.locator('.chat-composer-warning')).to_contain_text('Рекомендуем общаться по Telegram')
        seller.get_by_role('button', name='Отправить', exact=True).click()
        expect(buyer.get_by_role('listitem').get_by_text(other_contact, exact=True)).to_be_visible(timeout=12000)
        expect(buyer.locator('.chat-contact-warning')).to_contain_text('Жалобы на такую переписку не рассматриваем')
        print('PASS live delivery and warning for unlinked Telegram')

        seller.get_by_role('button', name='Пожаловаться', exact=True).click()
        expect(seller.get_by_role('combobox', name='Где это произошло', exact=True)).to_have_count(0)
        seller.get_by_role('button', name='Отмена', exact=True).click()

        buyer.get_by_role('button', name='Предложить обмен', exact=True).click()
        expect(buyer.get_by_text('Запрос на обмен Telegram отправлен', exact=True)).to_be_visible()
        expect(seller.get_by_text('Собеседник предлагает обменяться Telegram', exact=True)).to_be_visible(timeout=12000)
        expect(seller.get_by_role('link', name=f'@{buyer_handle}', exact=True)).to_have_count(0)
        seller.get_by_role('button', name='Отклонить', exact=True).click()
        expect(buyer.get_by_text('Запрос на обмен Telegram отклонён', exact=True)).to_be_visible(timeout=12000)
        expect(buyer.get_by_role('link', name=f'@{seller_handle}', exact=True)).to_have_count(0)
        buyer.get_by_role('button', name='Предложить обмен', exact=True).click()
        expect(seller.get_by_role('button', name='Согласиться', exact=True)).to_be_visible(timeout=12000)
        seller.get_by_role('button', name='Согласиться', exact=True).click()
        expect(seller.get_by_role('link', name=f'@{buyer_handle}', exact=True)).to_have_attribute('href', f'https://t.me/{buyer_handle}')
        expect(buyer.get_by_role('link', name=f'@{seller_handle}', exact=True)).to_have_attribute('href', f'https://t.me/{seller_handle}', timeout=12000)
        buyer.get_by_role('textbox', name='Сообщение', exact=True).fill(f'https://t.me/{seller_handle}')
        expect(buyer.locator('.chat-composer-warning')).to_have_count(0)
        assert external_overflow(seller) == 0
        print('PASS decline, retry, mutual consent, and both verified Telegram links')

        buyer.get_by_role('button', name='Оставить отзыв', exact=True).click()
        five_stars = buyer.get_by_role('radio', name='5 из 5', exact=True)
        five_stars.focus()
        five_stars.press('Space')
        expect(five_stars).to_be_checked()
        buyer.get_by_role('textbox', name='Комментарий (необязательно)', exact=True).fill('Быстро ответил на вопрос о поставке.')
        buyer.get_by_role('button', name='Отправить отзыв', exact=True).click()
        expect(buyer.get_by_text('Отзыв отправлен.', exact=True)).to_be_visible()
        expect(buyer.get_by_role('button', name='Оставить отзыв', exact=True)).to_have_count(0)

        seller.get_by_role('button', name='Пожаловаться', exact=True).click()
        seller.get_by_role('combobox', name='Причина', exact=True).select_option('OTHER')
        seller.get_by_role('combobox', name='Где это произошло', exact=True).select_option('VERIFIED_TELEGRAM')
        seller.get_by_role('textbox', name='Что произошло').fill('Тест маршрута жалобы после взаимного согласия.')
        seller.get_by_role('button', name='Отправить жалобу', exact=True).click()
        expect(seller.get_by_text('Жалоба отправлена модератору.', exact=True)).to_be_visible()
        expect(seller.get_by_role('button', name='Пожаловаться', exact=True)).to_have_count(0)
        assert external_overflow(seller) == 0
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        buyer.screenshot(path=ARTIFACTS / 'chat-desktop.png', full_page=True)
        seller.screenshot(path=ARTIFACTS / 'chat-mobile.png', full_page=True)
        for width in [320, 390, 768, 900, 980, 1024, 1440]:
            buyer.set_viewport_size({'width': width, 'height': 844})
            expect(buyer.get_by_role('heading', name='Сообщения', exact=True)).to_be_visible()
            assert external_overflow(buyer) == 0, f'Chat overflows at {width}px'
        assert not browser_errors, browser_errors
        print('PASS keyboard star review, moderator report, responsive chat from 320 to 1440 CSS pixels, and JavaScript console')
    finally:
        if listing_id:
            seller_context.request.delete(f'{API}/listings/{listing_id}')
        buyer_context.close()
        seller_context.close()
        stranger_context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        try:
            run(browser)
        finally:
            browser.close()
