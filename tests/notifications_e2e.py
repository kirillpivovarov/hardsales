"""Chat badges and private notification previews on a disposable local demo."""

import os
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from chat_e2e import API, BASE_URL, CHROMIUM, external_overflow, login, publish_listing, response_json


def check(browser):
    buyer_context = browser.new_context(base_url=BASE_URL, viewport={'width': 1280, 'height': 800})
    seller_context = browser.new_context(
        base_url=BASE_URL, viewport={'width': 375, 'height': 815}, is_mobile=True, has_touch=True,
    )
    try:
        buyer, _ = login(buyer_context, 'test2')
        seller, seller_user = login(seller_context, 'test1')
        errors = []
        for page in (buyer, seller):
            page.on('pageerror', lambda err: errors.append(str(err)))
        listing = publish_listing(seller_context, 'Уведомления ' + uuid4().hex[:8])
        chat = response_json(buyer_context.request.post(f'{API}/chats', data={'listingId': listing}))
        url = f'/chats/{chat["id"]}'
        body = 'Текст переписки, который виден только внутри чата.'
        for _ in range(2):
            response_json(buyer_context.request.post(f'{API}{url}/messages', data={'body': body}))
        expected = response_json(seller_context.request.get(f'{API}/chats/unread-count'))['unread']
        assert expected > 1

        for width in (375, 1280):
            if width == 375:
                page = seller
            else:
                context = browser.new_context(base_url=BASE_URL, viewport={'width': width, 'height': 800})
                context.add_cookies(seller_context.cookies())
                page = context.new_page()
                page.on('pageerror', lambda err: errors.append(str(err)))
            polls = []
            page.on('request', lambda outgoing: polls.append(outgoing.url) if '/notifications/counts' in outgoing.url else None)
            page.goto('/catalog')
            if width == 375:
                page.get_by_role('button', name='Открыть меню').click()
            link = page.get_by_role('link', name=f'Чаты, непрочитанных: {expected}', exact=True)
            expect(link).to_be_visible()
            expect(link.get_by_text(str(expected), exact=True)).to_be_visible()
            assert len(polls) == 1, polls
            assert external_overflow(page) == 0
            if width != 375:
                context.close()

        seller.goto('/notifications')
        notice = seller.locator('article').filter(has_text='Новых сообщений: 2')
        expect(notice.get_by_role('link', name='Открыть чат', exact=True)).to_have_attribute('href', url)
        expect(notice.get_by_text(body)).to_have_count(0)
        notice.get_by_role('link', name='Открыть чат', exact=True).click()
        expect(seller.get_by_role('listitem').filter(has_text=body).first).to_be_visible()
        bell = seller.get_by_role('button', name='Открыть меню')
        bell.click()
        expect(seller.get_by_role('link', name=f'Чаты, непрочитанных: {expected}', exact=True)).to_have_count(0)
        counts = response_json(seller_context.request.get(f'{API}/notifications/counts'))
        assert counts['chats'] == expected - 2, (seller_user['id'], counts)
        if not counts['chats']:
            expect(seller.get_by_role('link', name='Чаты', exact=True)).to_be_visible()
        assert external_overflow(seller) == 0
        assert not errors, errors
    finally:
        seller_context.close()
        buyer_context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROMIUM or os.environ.get('CHROMIUM_PATH'), headless=True,
            args=['--no-sandbox'],
        )
        try:
            check(browser)
        finally:
            browser.close()
    print('PASS chat badges and private notices at 375/1280 px')
