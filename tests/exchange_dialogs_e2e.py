"""Check row actions and direct links on a disposable maxv demo instance."""

from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright

from exchange_admin_e2e import BASE, CHROMIUM, TAG, activate_staff, api, button, heading


def section(page, part):
    page.goto(f'{BASE}/admin?section=exchange&part={part}')


def visible_dialog(page, trigger, label):
    trigger.scroll_into_view_if_needed()
    scroll = page.evaluate('window.scrollY')
    trigger.click()
    dialog = page.get_by_role('dialog', name=label, exact=True)
    expect(dialog).to_be_in_viewport()
    expect(heading(dialog, label)).to_be_focused()
    assert page.evaluate('window.scrollY') == scroll, (page.url, scroll)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.url
    return dialog


def invitations(page, admin):
    note = 'Проверка отзыва ' + TAG
    api(admin, 'admin/invites', 'POST', {
        'count': 15, 'note': note, 'expiresInDays': 30,
    }, status=201)
    target = api(admin, 'admin/invites?' + urlencode({'q': note}))['items'][-1]
    section(page, 'invites')
    row = page.get_by_role('row').filter(has_text=target['code'])
    trigger = button(row, 'Отозвать')
    label = f'Отозвать приглашение {target["code"]}'
    dialog = visible_dialog(page, trigger, label)
    assert page.evaluate('window.scrollY') > 200
    dialog.get_by_label('Причина отзыва').fill('Отмена с клавиатуры')
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    expect(row.get_by_text('Свободен', exact=True)).to_be_visible()
    dialog = visible_dialog(page, trigger, label)
    expect(dialog.get_by_label('Причина отзыва')).to_have_value('')
    dialog.get_by_label('Причина отзыва').fill('Проверка отзыва приглашения')
    button(dialog, 'Отозвать приглашение').click()
    expect(dialog).not_to_be_visible()
    expect(button(row, 'Копировать код')).to_be_focused()
    expect(row.get_by_text('Приглашение отозвано.', exact=True)).to_be_visible()
    expect(row.get_by_text('Отозван', exact=True)).to_be_visible()
    print('PASS invite cancellation, focus restoration, revoke and feedback in the selected row')


def corridors(page, admin):
    models = api(admin, 'admin/models?limit=12')['items']
    assert len(models) >= 8
    basis = 'SELLER_WAREHOUSE'
    for model in models:
        api(admin, f'admin/corridors/{model["id"]}/{basis}', 'PUT',
            {'minUsd': 1100, 'maxUsd': 2200})
    before = api(admin, 'admin/corridors')
    target = before[-1]
    path = f'admin/corridors/{target["modelId"]}/{target["basis"]}'
    section(page, 'corridors')
    row = page.get_by_role('listitem').filter(has=page.get_by_text(target['modelName'], exact=True))
    trigger = button(row, 'Редактировать')
    dialog = visible_dialog(page, trigger, 'Изменить ценовой ориентир')
    assert page.evaluate('window.scrollY') > 200
    expect(dialog.get_by_label('Код модели')).to_have_count(0)
    expect(dialog.get_by_label('Условия поставки')).to_have_count(0)
    new_max = float(target['maxUsd']) + 1100
    dialog.get_by_label('Максимум, USD').fill(str(new_max))
    button(dialog, 'Сохранить').click()
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    expect(row.get_by_text('Ценовой ориентир сохранён.', exact=True)).to_be_visible()
    entries = api(admin, 'admin/corridors')
    assert [(item['modelId'], item['basis']) for item in entries] == [
        (item['modelId'], item['basis']) for item in before
    ]
    assert float(entries[-1]['maxUsd']) == new_max

    dialog = visible_dialog(page, button(page, 'Добавить ценовой ориентир'), 'Добавить ценовой ориентир')
    dialog.get_by_label('Код модели').fill(target['modelId'])
    dialog.get_by_label('Условия поставки').select_option(target['basis'])
    dialog.get_by_label('Минимум, USD').fill('1400')
    dialog.get_by_label('Максимум, USD').fill('1600')
    button(dialog, 'Сохранить').click()
    expect(dialog.get_by_role('alert')).to_contain_text('ориентир уже есть')
    assert api(admin, 'admin/corridors') == entries
    button(dialog, 'Отмена').click()

    remove = button(row, 'Удалить')
    dialog = visible_dialog(page, remove, 'Удалить ценовой ориентир')
    button(dialog, 'Отмена').click()
    expect(remove).to_be_focused()
    assert api(admin, 'admin/corridors') == entries
    dialog = visible_dialog(page, remove, 'Удалить ценовой ориентир')
    with page.expect_response(lambda response: response.url.endswith(path) and response.request.method == 'DELETE') as reply:
        button(dialog, 'Удалить').click()
    assert reply.value.ok
    expect(row).to_have_count(0)
    expect(heading(page, 'Ценовые ориентиры')).to_be_focused()
    print('PASS price edit from deep in list, immutable key, duplicate prevention and deliberate deletion')


def disclosures(page, seller, buyer):
    title = 'Запись для журнала ' + TAG
    gpu = next(row for row in api(seller, 'categories') if row['slug'] == 'gpu')
    listing = api(seller, 'listings', 'POST', {
        'categoryId': gpu['id'], 'modelId': 'h100-pcie', 'title': title, 'description': 'Проверочное предложение оборудования со склада.',
        'availability': 'STOCK', 'originCountry': 'RU', 'stockCity': 'Казань',
    }, status=201)
    chat = api(buyer, 'chats', 'POST', {'listingId': listing['id']}, status=201)
    path = f'chats/{chat["id"]}/reveal'
    consent = api(buyer, path, 'PATCH', {'action': 'REQUEST', 'rulesAccepted': True})
    api(seller, path, 'PATCH', {'action': 'ACCEPT', 'requestId': consent['revealRequestId'], 'rulesAccepted': True})
    record = api(seller, 'disclosures')['items'][0]
    section(page, 'disclosures')
    row = page.get_by_role('listitem').filter(has_text=title)
    trigger = button(row, 'Открыть запись')
    dialog = visible_dialog(page, trigger, 'Запись раскрытия')
    expect(heading(dialog, record['number'])).to_be_visible()
    url = f'{BASE}/admin?{urlencode({"section": "exchange", "part": "disclosures", "id": record["id"]})}'
    expect(page).to_have_url(url)
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    page.goto(url)
    expect(dialog).to_be_in_viewport()
    expect(heading(dialog, record['number'])).to_be_visible()
    note = 'Проверка отображения заметки ' + TAG
    dialog.get_by_label('Заметка модератора').fill(note)
    button(dialog, 'Добавить заметку').click()
    expect(dialog.get_by_text('Заметка добавлена.', exact=True)).to_be_visible()
    expect(dialog.get_by_text(note, exact=True)).to_be_visible()
    button(dialog, 'К журналу раскрытий').click()
    expect(dialog).not_to_be_visible()
    expect(heading(page, 'Журнал раскрытий')).to_be_focused()
    print('PASS mobile disclosure, sharable URL, note feedback and return focus')


def principals(page, moderator, seller):
    api(seller, 'me/representation', 'PATCH', {'representationMode': 'AGENT'})
    name = 'Принципал для проверки ' + TAG
    row_data = api(seller, 'me/principals', 'POST', {'name': name, 'company': 'Тестовая компания'}, status=201)
    section(page, 'principals')
    row = page.get_by_role('listitem').filter(has_text=name)
    trigger = button(row, 'Подтвердить вручную')
    dialog = visible_dialog(page, trigger, 'Подтвердить полномочия')
    expect(dialog.get_by_text(name, exact=False)).to_be_visible()
    button(dialog, 'Отмена').click()
    expect(trigger).to_be_focused()
    dialog = visible_dialog(page, trigger, 'Подтвердить полномочия')
    dialog.get_by_label('Причина', exact=True).fill('Действительность полномочий проверена.')
    button(dialog, 'Подтвердить').click()
    expect(dialog).not_to_be_visible()
    expect(row).to_have_count(0)
    expect(heading(page, 'Принципалы')).to_be_focused()
    expect(page.get_by_text('Полномочия принципала подтверждены.', exact=True)).to_be_visible()
    entries = api(moderator, 'admin/principals?status=CONFIRMED')['items']
    assert any(entry['id'] == row_data['id'] and entry['confirmedVia'] == 'ADMIN' for entry in entries)
    print('PASS mobile moderator confirms the selected principal, with feedback after filtering the row out')


def run(browser):
    admin = browser.new_context(viewport={'width': 1440, 'height': 900})
    moderator = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    seller = browser.new_context()
    buyer = browser.new_context()
    activate_staff(admin, moderator)
    for context, login in ((seller, 'test1'), (buyer, 'test2')):
        api(context, 'auth/login', 'POST', {'login': login, 'password': login})
    for feature in ('feature_disclosure_journal', 'feature_representation', 'feature_trust_rating'):
        api(admin, f'admin/settings/{feature}', 'PUT', {'value': True})
    desktop, mobile = admin.new_page(), moderator.new_page()
    for page in (desktop, mobile):
        page.set_default_timeout(45000)
    invitations(desktop, admin)
    corridors(desktop, admin)
    disclosures(mobile, seller, buyer)
    principals(mobile, moderator, seller)


if __name__ == '__main__':
    expect.set_options(timeout=45000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            run(browser)
        finally:
            browser.close()
