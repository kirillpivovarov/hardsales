"""Operator matching on a disposable demo instance with all exchange features enabled."""

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from automatic_matches_e2e import BASE, api, assert_public, check_width
from contextual_moderation_e2e import activate_staff


TAG = uuid4().hex[:8]


def member(context, name):
    user = api(context, 'POST', '/auth/login', {'login': name, 'password': name})['user']
    if user.get('pdConsentRequired'):
        settings = api(context, 'GET', '/platform/features')
        api(context, 'POST', '/auth/consent', {'pdPolicyVersion': settings['pd_policy_version']})
    return user


def narrow_list(context, pair, query=''):
    result = api(context, 'GET', '/admin/near-misses?limit=100' + query)
    return next((row for row in result['items'] if row['sell']['id'] == pair['sellListingId']
                 and row['buy']['id'] == pair['buyListingId']), None)


def run(browser):
    seller = browser.new_context(base_url=BASE, viewport={'width': 1440, 'height': 900})
    buyer = browser.new_context(base_url=BASE, viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    guest = browser.new_context(base_url=BASE)
    admin = browser.new_context(base_url=BASE, viewport={'width': 1440, 'height': 900})
    moderator = browser.new_context(base_url=BASE, viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    activate_staff(admin, moderator)
    assert api(guest, 'GET', '/platform/features')['feature_matching'] is True
    owner = member(seller, 'test1')
    member(buyer, 'test2')
    api(guest, 'GET', '/admin/near-misses', status=401)
    api(buyer, 'GET', '/admin/near-misses', status=403)
    api(moderator, 'GET', '/admin/fx-rates', status=403)
    api(moderator, 'PUT', '/admin/settings/near_miss_max_failures', {'value': 3}, status=403)
    api(admin, 'PUT', '/admin/settings/near_miss_max_failures', {'value': 4}, status=400)
    api(admin, 'PUT', '/admin/settings/near_miss_price_over', {'value': 0.03}, status=400)

    category = next(entry['id'] for entry in api(seller, 'GET', '/categories') if entry['slug'] == 'servers')
    base = {'categoryId': category, 'description': 'Проверяем ручное сведение заявки и предложения на сервер.',
            'condition': 'NEW', 'priceMode': 'FIXED', 'currency': 'USD', 'paymentMethods': ['BANK_TRANSFER'],
            'originCountry': 'RU'}
    sell = {**base, 'title': f'HGX H200 предложение {TAG}', 'modelId': 'hgx-h200-8', 'quantity': 8, 'minLot': 2,
            'price': 896, 'availability': 'ORDER', 'originScope': 'COUNTRY', 'shipDays': 0}
    buy = {**base, 'title': f'DGX H200 заявка {TAG}', 'modelId': 'dgx-h200', 'quantity': 4, 'minLot': 1,
           'price': 400, 'originScope': 'DOMESTIC', 'destinationCountry': 'RU',
           'deliveryBy': (datetime.now(timezone.utc) + timedelta(days=7)).date().isoformat()}
    offer = api(seller, 'POST', '/listings', sell)
    request = api(buyer, 'POST', '/listings', buy)
    pair = {'sellListingId': offer['id'], 'buyListingId': request['id']}
    comment = 'Проверьте, подойдёт ли альтернативная конфигурация сервера.'
    proposal = '/admin/near-misses/propose'
    api(buyer, 'POST', proposal, {**pair, 'comment': comment}, status=403)
    initial = narrow_list(moderator, pair, '&modelId=hgx-h200-8')
    assert [entry['key'] for entry in initial['failures']] == ['MODEL_ANALOG', 'PRICE_OVER']
    assert initial['failures'][1]['text'] == 'Цена выше бюджета на 12,0 %'
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8&maxFailures=1') is None

    # Cache signatures include configured thresholds and distinct reason/model filters.
    api(seller, 'PATCH', f"/listings/{offer['id']}", {'price': 1000})
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8&key=PRICE_OVER') is None
    api(admin, 'PUT', '/admin/settings/near_miss_price_over', {'value': 0.30})
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8&key=PRICE_OVER') is not None
    api(seller, 'PATCH', f"/listings/{offer['id']}", {'price': 896, 'shipDays': 20})
    assert narrow_list(moderator, pair, '&key=SHIP_DATE') is None
    api(admin, 'PUT', '/admin/settings/near_miss_max_failures', {'value': 3})
    assert [entry['key'] for entry in narrow_list(moderator, pair, '&key=SHIP_DATE')['failures']] == [
        'MODEL_ANALOG', 'SHIP_DATE', 'PRICE_OVER',
    ]
    api(seller, 'PATCH', f"/listings/{offer['id']}", {'shipDays': 0})
    api(admin, 'PUT', '/admin/settings/near_miss_price_over', {'value': 0.2})
    api(admin, 'PUT', '/admin/settings/near_miss_max_failures', {'value': 2})

    dismiss = '/admin/near-misses/dismiss'
    api(moderator, 'POST', dismiss, {**pair, 'note': 'Проверка обратимого скрытия'})
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8') is None
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8&dismissed=true')['note'] == 'Проверка обратимого скрытия'
    api(moderator, 'DELETE', dismiss, pair)
    api(moderator, 'DELETE', dismiss, pair, status=404)
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8') is not None

    api(moderator, 'POST', proposal, {**pair, 'comment': 'Можете обсудить по номеру 89001234567.'}, status=400)
    api(moderator, 'POST', proposal, {**pair, 'comment': f"Участник {owner['displayName']} согласен обсудить."}, status=400)
    page = moderator.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('/admin?section=exchange&part=matching')
    page.get_by_role('button', name='Почти совпадения', exact=True).click()
    card = page.locator('article').filter(has_text=offer['title']).filter(has_text=request['title'])
    trigger = card.get_by_role('button', name='Предложить совпадение', exact=True)
    trigger.click()
    dialog = page.get_by_role('dialog', name='Предложить совпадение')
    expect(dialog).to_be_visible()
    check_width(page)
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    trigger.click()
    dialog.locator('textarea[name=comment]').fill(comment)
    with page.expect_response(lambda response: response.url.endswith('/api/v1' + proposal) and response.request.method == 'POST') as response:
        dialog.get_by_role('button', name='Отправить предложение', exact=True).click()
    assert response.value.ok, response.value.text()
    match_id = response.value.json()['matchId']
    expect(dialog).not_to_be_visible()
    expect(page.get_by_text('предложено обеим сторонам', exact=False)).to_be_visible()
    api(moderator, 'POST', proposal, {**pair, 'comment': comment}, status=409)
    assert narrow_list(moderator, pair, '&modelId=hgx-h200-8') is None
    projection = api(buyer, 'GET', '/matches/' + match_id)
    assert projection['status'] == 'NEW' and projection['source'] == 'OPERATOR' and projection['operatorComment'] == comment
    assert 'proposedBy' not in projection
    assert_public(projection)
    report = api(moderator, 'GET', '/admin/matches?source=OPERATOR')
    assert any(row['id'] == match_id and row['proposedBy']['nickname'] == 'Модератор тестирования' for row in report['items'])
    for context in (seller, buyer):
        notifications = api(context, 'GET', '/notifications')['items']
        announcement = next(row for row in notifications if row['title'] == 'Модератор предлагает совпадение')
        assert comment in announcement['body'] and announcement['payload']['matchIds'] == [match_id]
        assert {entry['action'] for entry in announcement['actions']} == {'OPEN_MATCH', 'match.chat', 'match.decline'}
    chat_token = next(entry['token'] for entry in announcement['actions'] if entry['action'] == 'match.chat')

    api(seller, 'PATCH', f"/listings/{offer['id']}", {'price': 1050})
    assert api(buyer, 'GET', '/matches/' + match_id)['status'] == 'NEW'
    assert api(buyer, 'GET', '/matches/' + match_id)['mismatches'] == projection['mismatches']
    api(seller, 'DELETE', f"/listings/{offer['id']}")
    assert api(buyer, 'GET', '/matches/' + match_id)['status'] == 'VOID'
    api(seller, 'POST', f"/listings/{offer['id']}/restore")
    assert api(buyer, 'GET', '/matches/' + match_id)['status'] == 'NEW'

    member_page = buyer.new_page()
    member_page.on('pageerror', lambda error: errors.append(str(error)))
    member_page.goto('/matches/' + match_id)
    expect(member_page.get_by_text('Предложено модератором', exact=True)).to_be_visible()
    expect(member_page.get_by_text(comment, exact=True)).to_be_visible()
    check_width(member_page)
    member_page.get_by_role('button', name='Написать', exact=True).click()
    member_page.wait_for_url('**/chats/*')
    assert api(buyer, 'GET', '/matches/' + match_id)['status'] == 'CHAT'
    chat_id = member_page.url.rsplit('/', 1)[-1]
    assert api(seller, 'POST', '/matches/' + match_id + '/chat')['chatId'] == chat_id
    assert api(guest, 'POST', '/actions/' + chat_token, {})['chatId'] == chat_id
    api(guest, 'POST', '/actions/' + chat_token, {}, status=409)

    guessed = api(seller, 'POST', '/listings', {**sell, 'modelId': None, 'price': 800,
                                               'title': f'HGX H200 свободное описание {TAG}'})
    inferred = {**pair, 'sellListingId': guessed['id']}
    candidate = narrow_list(moderator, inferred, '&modelId=hgx-h200-8&key=MODEL_MISSING')
    assert [entry['key'] for entry in candidate['failures']] == ['MODEL_MISSING']
    assert candidate['suggestedModel']['id'] == 'hgx-h200-8'
    inferred_match = api(moderator, 'POST', proposal, {**inferred, 'comment': comment})
    underlying = api(buyer, 'GET', '/matches/' + inferred_match['matchId'])
    assert underlying['model']['id'] == 'hgx-h200-8' and underlying['model']['byTitle'] is True
    notice = next(item for item in api(buyer, 'GET', '/notifications')['items']
                  if item['payload'].get('matchIds') == [inferred_match['matchId']])
    token = next(action['token'] for action in notice['actions'] if action['action'] == 'match.decline')
    action = api(guest, 'GET', '/actions/' + token)
    assert action['purpose'] == 'match.decline' and 'Форма оплаты не подходит' in action['fields']['reasons']
    assert api(guest, 'POST', '/actions/' + token, {'reason': 'Другое'})['status'] == 'DECLINED'
    api(guest, 'POST', '/actions/' + token, {'reason': 'Другое'}, status=409)
    api(moderator, 'POST', proposal, {**inferred, 'comment': comment}, status=409)
    assert any(item['kind'] == 'match.operator_declined' and 'Другое' in item['body']
               for item in api(moderator, 'GET', '/notifications')['items'])
    assert not errors, errors
    print('OK operator roles, filters, dialog/focus at 375px, notifications, visibility, inferred model, chat and single-use decline')


if __name__ == '__main__':
    expect.set_options(timeout=30_000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'), headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        run(browser)
        browser.close()
