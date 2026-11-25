"""Browser chat regression against a disposable demo database."""

import json
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

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


def publish_listing(context, title, kind='SELL'):
    categories = response_json(context.request.get(f'{API}/categories'))
    category = next(category for category in categories if category['active'])
    terms = {'availability': 'STOCK', 'stockCity': 'Москва', 'originCountry': 'RU'} if kind == 'SELL' else {
        'originScope': 'ANY', 'destinationCountry': 'RU',
        'deliveryBy': (date.today() + timedelta(days=30)).isoformat(),
    }
    listing = response_json(context.request.post(f'{API}/listings', data={
        'title': title, 'description': 'Тестовое описание для проверки чата hwforai.',
        'kind': kind, 'categoryId': category['id'], 'quantity': 2, 'condition': 'NEW',
        'priceMode': 'NEGOTIABLE', 'currency': 'RUB', 'paymentMethods': ['BANK_TRANSFER'], **terms,
    }))
    return listing['id']


def start_chat(page, listing_id):
    page.goto(f'/listings/{listing_id}')
    page.get_by_role('button', name='Написать', exact=True).click()
    page.wait_for_url('**/chats/*')
    return page.url.split('/')[-1]


def change_telegram(profile, handle):
    profile.goto('/account')
    expect(profile.get_by_text('После смены имени пользователя нужно обменяться контактами заново.', exact=False)).to_be_visible()
    profile.locator('input[name=telegram]').fill(handle)
    profile.get_by_role('button', name='Сохранить профиль', exact=True).click()
    expect(profile.get_by_text('Профиль обновлён.', exact=True)).to_be_visible()


def expect_telegram(page, handle):
    expect(page.get_by_role('link', name=f'@{handle}', exact=True)).to_have_attribute('href', f'https://t.me/{handle}', timeout=12000)


def run(browser):
    seller_context = browser.new_context(base_url=BASE_URL, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    buyer_context = browser.new_context(base_url=BASE_URL, viewport={'width': 1440, 'height': 1000})
    stranger_context = browser.new_context(base_url=BASE_URL)
    title = 'Тест переписки ' + datetime.now().strftime('%H%M%S%f')
    listings = []
    nonce = uuid4().hex[:10]
    seller_handle, new_seller_handle = f'qainitial_{nonce}', f'qachanged_{nonce}'
    seller_profile = None
    original_seller_handle = None
    try:
        seller, seller_user = login(seller_context, 'test1')
        buyer, buyer_user = login(buyer_context, 'test2')
        original_seller_handle = seller_user['telegram']
        seller_profile = seller_context.new_page()
        browser_errors = []
        buyer_second, seller_second, seller_third = buyer_context.new_page(), seller_context.new_page(), seller_context.new_page()
        for page in [buyer, seller, buyer_second, seller_second, seller_third, seller_profile]:
            page.on('pageerror', lambda error: browser_errors.append(str(error)))

        # Start from unrevealed contacts even when the demo pair exchanged them on a previous run.
        change_telegram(seller_profile, seller_handle)
        listing_id = publish_listing(seller_context, title)
        listings.append((seller_context, listing_id))
        second_listing = publish_listing(seller_context, f'{title} — второй лот')
        listings.append((seller_context, second_listing))
        chat_id = start_chat(buyer, listing_id)
        expect(buyer.get_by_role('heading', name='Сообщения', exact=True)).to_be_visible()
        expect(buyer.get_by_text('Telegram скрыт', exact=True)).to_be_visible()
        buyer_handle = buyer_user['telegram'].lstrip('@')
        initial_chat = response_json(buyer_context.request.get(f'{API}/chats/{chat_id}'))
        assert seller_handle not in json.dumps(initial_chat)
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
        seller.get_by_role('textbox', name='Сообщение', exact=True).fill('tg://join?invite=unlinked_purchase')
        expect(seller.locator('.chat-composer-warning')).to_be_visible()
        seller.get_by_role('textbox', name='Сообщение', exact=True).fill(other_contact)
        expect(seller.locator('.chat-composer-warning')).to_contain_text('Рекомендуем общаться по Telegram')
        seller.get_by_role('button', name='Отправить', exact=True).click()
        expect(buyer.get_by_role('listitem').get_by_text(other_contact, exact=True)).to_be_visible(timeout=12000)
        expect(buyer.locator('.chat-contact-warning')).to_contain_text('Жалобы на такую переписку не рассматриваем')
        print('PASS live delivery and warning for unlinked Telegram')

        seller.get_by_role('button', name='Пожаловаться', exact=True).click()
        expect(seller.get_by_role('combobox', name='Где это произошло', exact=True)).to_have_count(int(initial_chat['canReportTelegram']))
        seller.get_by_role('button', name='Отмена', exact=True).click()

        request = buyer.get_by_role('button', name=re.compile('^Предложить обмен(?: заново)?$'))
        request.click()
        expect(buyer.get_by_text('Запрос на обмен Telegram отправлен', exact=True)).to_be_visible()
        expect(seller.get_by_text('Собеседник предлагает обменяться Telegram', exact=True)).to_be_visible(timeout=12000)
        expect(seller.get_by_role('link', name=f'@{buyer_handle}', exact=True)).to_have_count(0)
        seller.get_by_role('button', name='Отклонить', exact=True).click()
        expect(buyer.get_by_text('Запрос на обмен Telegram отклонён', exact=True)).to_be_visible(timeout=12000)
        expect(buyer.get_by_role('link', name=f'@{seller_handle}', exact=True)).to_have_count(0)
        request.click()
        second_chat_id = start_chat(buyer_second, second_listing)
        assert second_chat_id != chat_id
        expect(buyer_second.get_by_text('Запрос на обмен Telegram отправлен', exact=True)).to_be_visible()
        seller_second.goto(f'/chats/{second_chat_id}')
        expect(seller_second.get_by_role('button', name='Согласиться', exact=True)).to_be_visible(timeout=12000)
        seller_second.get_by_role('button', name='Согласиться', exact=True).click()
        expect_telegram(seller_second, buyer_handle)
        expect_telegram(seller, buyer_handle)
        expect_telegram(buyer, seller_handle)
        expect_telegram(buyer_second, seller_handle)
        buyer.get_by_role('textbox', name='Сообщение', exact=True).fill(f'https://t.me/{seller_handle}')
        expect(buyer.locator('.chat-composer-warning')).to_have_count(0)
        assert external_overflow(seller) == 0
        purchase_listing = publish_listing(buyer_context, f'{title} — заявка покупателя', kind='BUY')
        listings.append((buyer_context, purchase_listing))
        third_chat_id = start_chat(seller_third, purchase_listing)
        expect_telegram(seller_third, buyer_handle)
        expect(seller_third.get_by_role('button', name='Предложить обмен', exact=True)).to_have_count(0)
        print('PASS decline, retry, acceptance in another listing chat and inherited consent in a new chat initiated by the seller')

        change_telegram(seller_profile, f'@{seller_handle.upper()}')
        case_only = response_json(buyer_context.request.get(f'{API}/chats/{chat_id}'))
        assert case_only['telegram']['partner'].lstrip('@').lower() == seller_handle
        assert case_only['telegramChanged'] is None
        change_telegram(seller_profile, f'@{new_seller_handle}')
        partner_changed = 'Собеседник изменил имя пользователя в Telegram.'
        own_changed = 'Вы изменили имя пользователя в Telegram.'
        for page in [buyer, buyer_second]:
            expect(page.get_by_role('status').get_by_text(partner_changed, exact=False)).to_be_visible(timeout=12000)
            expect(page.locator('.chat-telegram').get_by_role('link')).to_have_count(0)
        expect(buyer.locator('.chat-composer-warning')).to_be_visible()
        expect(seller_third.get_by_role('status').get_by_text(own_changed, exact=False)).to_be_visible(timeout=12000)
        expect(seller_third.get_by_role('link', name=f'@{buyer_handle}', exact=True)).to_have_count(0)
        for thread_id in [chat_id, second_chat_id, third_chat_id]:
            private_chat = response_json(buyer_context.request.get(f'{API}/chats/{thread_id}'))
            assert private_chat['telegram'] is None
            assert private_chat['telegramChanged'] == {'mine': False, 'partner': True}
            assert private_chat['canReportTelegram']
            assert seller_handle not in json.dumps(private_chat) and new_seller_handle not in json.dumps(private_chat)
        buyer_second.get_by_role('button', name='Пожаловаться', exact=True).click()
        expect(buyer_second.get_by_role('combobox', name='Где это произошло', exact=True)).to_be_visible()
        buyer_second.get_by_role('button', name='Отмена', exact=True).click()
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        buyer_second.screenshot(path=ARTIFACTS / 'chat-desktop-new-consent.png', full_page=True)
        seller_third.screenshot(path=ARTIFACTS / 'chat-mobile-new-consent.png', full_page=True)
        seller_third.set_viewport_size({'width': 320, 'height': 844})
        assert external_overflow(seller_third) == 0, 'Telegram change notice overflows at 320px'
        seller_third.get_by_role('button', name='Предложить обмен заново', exact=True).click()
        expect(buyer_second.get_by_role('button', name='Согласиться', exact=True)).to_be_visible(timeout=12000)
        expect(buyer_second.get_by_text(partner_changed, exact=False)).to_be_visible()
        buyer_second.get_by_role('button', name='Согласиться', exact=True).click()
        expect_telegram(buyer_second, new_seller_handle)
        expect_telegram(buyer, new_seller_handle)
        expect_telegram(seller_third, buyer_handle)
        expect(buyer.get_by_text(partner_changed, exact=False)).to_have_count(0)
        expect(buyer.locator('.chat-composer-warning')).to_be_visible()
        buyer.get_by_role('textbox', name='Сообщение', exact=True).fill(f'tg://resolve/?domain={new_seller_handle}')
        expect(buyer.locator('.chat-composer-warning')).to_have_count(0)
        print('PASS normalized edits preserve consent; different handles hide both contacts and require fresh cross-chat consent')

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
        buyer.screenshot(path=ARTIFACTS / 'chat-desktop.png', full_page=True)
        seller.screenshot(path=ARTIFACTS / 'chat-mobile.png', full_page=True)
        for width in [320, 390, 768, 900, 980, 1024, 1440]:
            buyer.set_viewport_size({'width': width, 'height': 844})
            expect(buyer.get_by_role('heading', name='Сообщения', exact=True)).to_be_visible()
            assert external_overflow(buyer) == 0, f'Chat overflows at {width}px'
        assert not browser_errors, browser_errors
        print('PASS keyboard star review, moderator report, responsive chat from 320 to 1440 CSS pixels, and JavaScript console')
    finally:
        for context, listing_id in listings:
            context.request.delete(f'{API}/listings/{listing_id}')
        if seller_profile and original_seller_handle:
            change_telegram(seller_profile, original_seller_handle)
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
