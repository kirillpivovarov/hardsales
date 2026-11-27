"""Exchange administration and seeded sign-ins on a disposable maxv demo instance.

Set HWFORAI_QA_BASE, HWFORAI_QA_MAILPIT_URL and optional CHROMIUM_PATH.
Start the instance with EXCHANGE_DEMO_FEATURES=true. The test changes the
administrator's initial password and creates a moderator.
"""

import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import complete_otp, login
from contextual_moderation_e2e import activate_staff

BASE = os.getenv('HWFORAI_QA_BASE', 'http://127.0.0.1:3000').rstrip('/')
CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
TAG = uuid4().hex[:8]
COMMON = ['Модели оборудования', 'Журнал раскрытий', 'Принципалы', 'Совпадения', 'Проверки и сделки', 'Фоновые задачи',
          'Письма', 'Показатели пробы', 'Дубли лотов', 'Приглашения']
ADMIN_ONLY = ['Настройки биржи', 'Курсы валют', 'Ценовые ориентиры', 'Попытки обхода', 'Telegram', 'Запросы по данным']
GENERATED_MODEL_CODE_HINT = 'Можно оставить пустым, чтобы сформировать код из названия.'


def api(context, path, method='GET', body=None, status=200):
    args = {'data': body} if body is not None else {}
    response = context.request.fetch(f'{BASE}/api/v1/{path}', method=method, headers={'Origin': BASE}, **args)
    assert response.status == status, (path, method, response.status, response.text())
    return response.json() if response.status != 204 else None


def button(scope, name):
    return scope.get_by_role('button', name=name, exact=True)


def heading(page, name):
    return page.get_by_role('heading', name=name, exact=True)


def navigation(page):
    return page.get_by_role('navigation', name='Управление биржей', exact=True)


def check_sections(page, expected):
    links = navigation(page).get_by_role('link')
    expect(links).to_have_count(len(expected))
    assert set(links.all_text_contents()) == set(expected)


def check_layout(page):
    widths = page.evaluate('({ viewport: innerWidth, document: document.documentElement.scrollWidth })')
    assert widths['document'] <= widths['viewport'], (page.url, widths)
    expect(page.get_by_role('alert')).to_have_count(0)


def open_section(page, name, path=None):
    link = navigation(page).get_by_role('link', name=name, exact=True)
    if path:
        with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v1/admin/' + path, timeout=45000) as reply:
            link.click()
        assert reply.value.ok, (path, reply.value.status)
    else:
        link.click()
    expect(link).to_have_attribute('aria-current', 'page')


def collect_errors(page, errors):
    page.on('pageerror', lambda error: errors.append((page.url, str(error))))
    page.on('console', lambda message: errors.append((page.url, message.text)) if message.type == 'error' else None)
    page.on('response', lambda response: errors.append((response.url, response.status))
            if '/api/v1/' in response.url and response.status >= 400 else None)


def invites(desktop, admin):
    open_section(desktop, 'Приглашения', 'invites')
    expect(heading(desktop, 'Создать приглашения')).to_be_visible()
    note = f'Проверка приглашения {TAG}'
    desktop.locator('input[name="note"]').fill(note)
    desktop.locator('select[name="presetRole"]').select_option('SELLER')
    with desktop.expect_response(lambda response: response.url.endswith('/api/v1/admin/invites') and response.request.method == 'POST', timeout=45000) as created:
        button(desktop, 'Создать приглашения').click()
    assert created.value.status == 201, created.value.status
    invite = created.value.json()['items'][0]
    assert invite['status'] == 'OPEN' and invite['presetRole'] == 'SELLER', invite['status']
    row = desktop.get_by_role('row').filter(has_text=note)
    expect(row.get_by_text(invite['code'], exact=True)).to_be_visible()
    expect(row.get_by_text('Свободен', exact=True)).to_be_visible()

    admin.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    desktop.bring_to_front()
    button(row, 'Копировать ссылку').click()
    expect(desktop.get_by_text('Ссылка скопирована.', exact=True)).to_be_visible()
    clipboard = urlsplit(desktop.evaluate('navigator.clipboard.readText()'))
    assert (clipboard.scheme, clipboard.netloc) == (urlsplit(BASE).scheme, urlsplit(BASE).netloc)
    assert clipboard.path == '/register' and parse_qs(clipboard.query) == {'invite': [invite['code']]}
    button(row, 'Копировать код').click()
    expect(desktop.get_by_text('Код скопирован.', exact=True)).to_be_visible()
    assert desktop.evaluate('navigator.clipboard.readText()') == invite['code']

    button(row, 'Отозвать').click()
    desktop.get_by_label('Причина отзыва', exact=True).fill(f'Проверка штатного отзыва {TAG}')
    button(desktop, 'Отозвать приглашение').click()
    expect(desktop.get_by_text('Приглашение отозвано.', exact=True)).to_be_visible()
    expect(row.get_by_text('Отозван', exact=True)).to_be_visible()
    expect(button(row, 'Копировать ссылку')).to_have_count(0)
    audit = api(admin, f'admin/audit?entityId={invite["id"]}')['items']
    assert {'created', 'revoked'} <= {item['action'] for item in audit if item['actorRole'] == 'ADMIN'}
    check_layout(desktop)
    return invite['id']


def setting(page, name):
    field = page.get_by_label(name, exact=True)
    return field, page.locator('form.exchange-setting').filter(has=field)


def change_setting(page, label, key, value):
    field, form = setting(page, label)
    if isinstance(value, bool):
        field.set_checked(value)
    else:
        field.fill(value)
    with page.expect_response(lambda response: response.url.endswith('/api/v1/admin/settings/' + key)
                              and response.request.method == 'PUT', timeout=45000) as reply:
        button(form, 'Сохранить').click()
    assert reply.value.ok, (key, reply.value.status)
    assert reply.value.json()['value'] == value
    expect(page.get_by_text('Изменения сохранены.', exact=True)).to_be_visible()


def settings(desktop, admin):
    open_section(desktop, 'Настройки биржи', 'settings')
    expect(heading(desktop, 'Настройки биржи')).to_be_visible()
    original = api(admin, 'platform/features')
    error = api(admin, 'admin/settings/timezone', 'PUT', {'value': 'Asia/No-Such-Zone'}, 400)
    assert 'Неизвестный часовой пояс' in error['message']
    assert api(admin, 'platform/features')['timezone'] == original['timezone']
    next_timezone = 'UTC' if original['timezone'] != 'UTC' else 'Europe/Moscow'
    change_setting(desktop, 'Часовой пояс площадки', 'timezone', next_timezone)
    assert api(admin, 'platform/features')['timezone'] == next_timezone
    change_setting(desktop, 'Часовой пояс площадки', 'timezone', original['timezone'])
    if not original['feature_trust_rating']:
        change_setting(desktop, 'Рейтинг и проверка', 'feature_trust_rating', True)
    assert api(admin, 'platform/features')['feature_trust_rating'] is True
    audit = api(admin, 'admin/audit?entityId=timezone')['items']
    assert len([entry for entry in audit if entry['action'] == 'update' and entry['actorRole'] == 'ADMIN']) >= 2
    check_layout(desktop)
    return original['feature_trust_rating']


def jobs(page):
    open_section(page, 'Фоновые задачи', 'jobs')
    expect(heading(page, 'Фоновые задачи')).to_be_visible()
    page.get_by_label('Имя задачи', exact=True).fill('platform.cleanup')
    with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v1/admin/jobs'
                              and parse_qs(urlsplit(response.url).query).get('job') == ['platform.cleanup'], timeout=45000) as reply:
        button(page, 'Найти').click()
    assert reply.value.ok
    assert all(item['job'] == 'platform.cleanup' for item in reply.value.json()['items'])
    expect(page.locator('.exchange-runs').get_by_text('platform.cleanup', exact=True).first).to_be_visible()
    check_layout(page)


def open_row_dialog(page, trigger, title, *, below_fold=False):
    trigger.scroll_into_view_if_needed()
    initial_scroll = page.evaluate('scrollY')
    if below_fold:
        assert initial_scroll > page.evaluate('innerHeight'), initial_scroll
    trigger.focus()
    trigger.click()
    dialog = page.get_by_role('dialog', name=title, exact=True)
    expect(dialog).to_have_count(1)
    expect(dialog).to_be_in_viewport(ratio=1)
    expect(dialog.get_by_role('heading')).to_be_in_viewport()
    assert dialog.evaluate('(element) => element.contains(document.activeElement)')
    page.keyboard.press('Tab')
    assert dialog.evaluate('(element) => element.contains(document.activeElement)')
    return dialog, initial_scroll


def cancel_row_dialog(page, dialog, trigger, initial_scroll):
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    expect(trigger).to_be_focused()
    current_scroll = page.evaluate('scrollY')
    assert abs(current_scroll - initial_scroll) <= 2, (initial_scroll, current_scroll)


def model_results(response, *, status, query=''):
    url = urlsplit(response.url)
    filters = parse_qs(url.query, keep_blank_values=True)
    return (url.path == '/api/v1/admin/models' and response.request.method == 'GET'
            and filters.get('status') == [status] and filters.get('q') == [query])


def edit_model_row(page, context, role, suffix):
    status = page.get_by_role('combobox', name='Статус')
    if status.input_value() != 'ACTIVE':
        with page.expect_response(lambda response: model_results(response, status='ACTIVE')) as filtered:
            status.select_option('ACTIVE')
        assert filtered.value.ok
    records = page.get_by_role('list', name='Модели оборудования', exact=True)
    expect(records).to_have_attribute('aria-busy', 'false')
    rows = records.locator(':scope > li').filter(has=button(page, 'Выключить'))
    expect(rows).to_have_count(20)
    row = rows.last
    trigger = button(row, 'Редактировать')
    original_name = row.locator('strong').inner_text()
    viewport = page.viewport_size['width']
    dialog, scroll = open_row_dialog(page, trigger, 'Редактирование модели', below_fold=True)
    field = dialog.get_by_label('Название на русском', exact=True)
    expect(field).to_have_value(original_name)
    expect(dialog.get_by_role('textbox', name='Код модели')).to_be_disabled()
    expect(dialog.get_by_text(GENERATED_MODEL_CODE_HINT, exact=True)).to_have_count(0)
    field.fill(f'Несохранённая модель {TAG}')
    cancel_row_dialog(page, dialog, trigger, scroll)
    expect(row.locator('strong')).to_have_text(original_name)

    dialog, _ = open_row_dialog(page, trigger, 'Редактирование модели', below_fold=True)
    field = dialog.get_by_label('Название на русском', exact=True)
    expect(field).to_have_value(original_name)
    screenshots = os.getenv('HWFORAI_SCREENSHOTS')
    if screenshots:
        path = Path(screenshots)
        path.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path / f'light-model-editor-{role.lower()}-{viewport}.png'), animations='disabled')
    new_name = f'Проверка модели {TAG} {suffix}'
    field.fill(new_name)
    with page.expect_response(lambda response: '/api/v1/admin/models/' in response.url
                              and response.request.method == 'PATCH') as updated:
        button(dialog, 'Сохранить').click()
    assert updated.value.ok, updated.value.status
    saved = updated.value.json()
    expect(dialog).to_have_count(0)
    expect(page.get_by_text(new_name, exact=True)).to_have_count(1)
    expect(page.get_by_text(original_name, exact=True)).to_have_count(0)
    expect(trigger).to_be_focused()
    expect(trigger).to_be_in_viewport()
    assert saved['nameRu'] == new_name
    assert saved['id'] in row.inner_text(), saved['id']
    result = api(context, f'admin/models?q={TAG}%20{suffix}')
    assert result['total'] == 1 and result['items'][0]['id'] == saved['id'], result
    audit = api(context, f'admin/audit?entityId={saved["id"]}')['items']
    assert any(item['actorRole'] == role and item['action'] == 'edited' for item in audit), audit

    status_trigger = button(row, 'Выключить')
    dialog, scroll = open_row_dialog(page, status_trigger, 'Выключить модель', below_fold=True)
    expect(dialog.get_by_label('Причина', exact=True)).to_be_visible()
    cancel_row_dialog(page, dialog, status_trigger, scroll)
    check_layout(page)
    print(f'PASS {viewport}px {role}: deep model edit, Escape focus and scroll, targeted save, audit and status dialog', flush=True)
    return saved


def merge_model_dialog(page, context, buyer):
    source = api(buyer, 'models/proposals', 'POST', {'name': f'Предложение {TAG}', 'category': 'gpu'}, 201)['model']
    status = page.get_by_role('combobox', name='Статус')
    with page.expect_response(lambda response: model_results(response, status='PENDING', query=source['nameRu'])) as filtered:
        status.select_option('PENDING')
        page.get_by_label('Поиск моделей', exact=True).fill(source['nameRu'])
    assert filtered.value.ok
    records = page.get_by_role('list', name='Модели оборудования', exact=True)
    expect(records).to_have_attribute('aria-busy', 'false')
    row = records.locator(':scope > li').filter(has=page.get_by_text(source['nameRu'], exact=True))
    trigger = button(row, 'Объединить')
    dialog, scroll = open_row_dialog(page, trigger, 'Объединить модели')
    expect(dialog.get_by_role('combobox', name='Объединить с моделью')).to_be_visible()
    expect(dialog.get_by_label('Причина', exact=True)).to_be_visible()
    cancel_row_dialog(page, dialog, trigger, scroll)
    assert api(context, f'admin/models?q={source["id"]}')['items'][0]['status'] == 'PENDING'
    return source


def models(page, context, administrator, buyer):
    open_section(page, 'Модели оборудования', 'models')
    expect(heading(page, 'Модели оборудования')).to_be_visible()
    add_model = button(page, 'Добавить модель')
    expect(add_model).to_be_enabled()
    if administrator:
        dialog, scroll = open_row_dialog(page, add_model, 'Новая модель')
        code = dialog.get_by_role('textbox', name='Код модели')
        expect(code).to_be_editable()
        expect(code).to_have_value('')
        expect(dialog.get_by_text(GENERATED_MODEL_CODE_HINT, exact=True)).to_be_visible()
        cancel_row_dialog(page, dialog, add_model, scroll)
    role = 'ADMIN' if administrator else 'MODERATOR'
    model = edit_model_row(page, context, role, 'desktop' if administrator else 'tablet')
    if administrator:
        pending = merge_model_dialog(page, context, buyer)
        api(buyer, f'admin/models/{model["id"]}', 'PATCH', {'nameRu': 'Недоступная правка'}, 403)
        api(buyer, f'admin/models/{model["id"]}/status', 'PATCH', {'status': 'DISABLED', 'reason': 'Чужая операция'}, 403)
        api(buyer, f'admin/models/{pending["id"]}/merge', 'POST', {'intoModelId': model['id'], 'reason': 'Чужая операция'}, 403)
    else:
        previous_viewport = page.viewport_size
        page.set_viewport_size({'width': 390, 'height': 844})
        try:
            edit_model_row(page, context, role, 'mobile')
        finally:
            page.set_viewport_size(previous_viewport)
    for tab, path, marker in [('Обновления каталога', 'catalog-sync/items', 'Ожидают проверки:'),
                              ('Источники', 'catalog-sync/sources', 'База PCI ID')]:
        with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v1/admin/' + path, timeout=45000) as reply:
            button(page, tab).click()
        assert reply.value.ok
        expect(page.get_by_text(marker, exact=False).first).to_be_visible()
        check_layout(page)
    if administrator:
        expect(button(page, 'Проверить сейчас').first).to_be_visible()
        trigger = button(page, 'Изменить адреса').last
        dialog, scroll = open_row_dialog(page, trigger, 'Адреса источника')
        urls = dialog.get_by_role('textbox', name='HTTPS-адреса, по одному в строке')
        sources = api(context, 'admin/catalog-sync/sources')
        expect(urls).to_have_value('\n'.join(sources[-1]['urls']))
        cancel_row_dialog(page, dialog, trigger, scroll)
    else:
        expect(button(page, 'Проверить сейчас')).to_have_count(0)
        expect(button(page, 'Изменить адреса')).to_have_count(0)
    button(page, 'Прежние объявления').click()
    expect(button(page, 'Найти предложения моделей')).to_be_visible()
    check_layout(page)


def shared_sections(page, context, administrator, buyer):
    open_section(page, 'Журнал раскрытий', 'disclosures')
    expect(heading(page, 'Журнал раскрытий')).to_be_visible()
    check_layout(page)
    open_section(page, 'Принципалы', 'principals')
    expect(heading(page, 'Принципалы')).to_be_visible()
    check_layout(page)
    open_section(page, 'Проверки и сделки', 'verification')
    expect(heading(page, 'Документы на проверке')).to_be_visible()
    check_layout(page)
    jobs(page)
    models(page, context, administrator, buyer)


def demo_sign_in(browser, base_path):
    moderator = browser.new_context(viewport={'width': 768, 'height': 1024}, is_mobile=True, has_touch=True)
    agent = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    try:
        tablet = moderator.new_page()
        tablet.set_default_timeout(45000)
        login(tablet, 'testmod', 'Moderator-Maxv-2026!', next_path=base_path)
        expect(heading(tablet, 'Подтвердите вход')).to_be_visible()
        complete_otp(tablet, 'testmod@example.test', test_incorrect=True)
        expect(tablet).to_have_url(BASE + base_path)
        assert api(moderator, 'auth/me')['user']['role'] == 'MODERATOR'
        check_sections(tablet, COMMON)
        check_layout(tablet)

        mobile = agent.new_page()
        mobile.set_default_timeout(45000)
        login(mobile, 'testagent', 'Agent-Maxv-2026!', next_path='/account')
        expect(heading(mobile, 'Подтвердите вход')).to_be_visible()
        complete_otp(mobile, 'testagent@example.test')
        expect(mobile).to_have_url(BASE + '/account')
        user = api(agent, 'auth/me')['user']
        assert user['role'] == 'SELLER' and user['representationMode'] == 'AGENT'
        expect(heading(mobile, 'Роль в сделках')).to_be_visible()
        expect(mobile.get_by_text('Демо поставщик', exact=False).first).to_be_visible()
        check_layout(mobile)
        api(agent, 'admin/principals', status=403)
        print('PASS real OTP for the 768px demo moderator and the 375px seller acting as an agent', flush=True)
    finally:
        moderator.close()
        agent.close()


def run(browser):
    base_path = '/admin?section=exchange'
    demo_sign_in(browser, base_path)
    admin = browser.new_context(viewport={'width': 1440, 'height': 1000})
    moderator = browser.new_context(viewport={'width': 768, 'height': 1024}, is_mobile=True, has_touch=True)
    buyer = browser.new_context(viewport={'width': 768, 'height': 1024}, is_mobile=True, has_touch=True)
    activate_staff(admin, moderator)
    assert api(admin, 'auth/me')['user']['role'] == 'ADMIN'
    assert api(moderator, 'auth/me')['user']['role'] == 'MODERATOR'
    participant_user = api(buyer, 'auth/login', 'POST', {'login': 'test2', 'password': 'test2'})['user']
    errors = []
    desktop, tablet, participant = admin.new_page(), moderator.new_page(), buyer.new_page()
    for page in (desktop, tablet, participant):
        page.set_default_timeout(45000)
        collect_errors(page, errors)
    desktop.goto(BASE + base_path)
    expect(heading(desktop, 'Закрытая биржа')).to_be_visible()
    check_sections(desktop, COMMON + ADMIN_ONLY)
    invites(desktop, admin)
    original_trust = settings(desktop, admin)
    try:
        shared_sections(desktop, admin, administrator=True, buyer=buyer)
        for name, route, marker in [('Совпадения', 'matches', desktop.get_by_label('Поиск совпадений', exact=True)),
                                    ('Курсы валют', 'fx-rates', heading(desktop, 'Курсы валют')),
                                    ('Ценовые ориентиры', 'corridors', heading(desktop, 'Ценовые ориентиры'))]:
            open_section(desktop, name, route)
            expect(marker).to_be_visible()
            check_layout(desktop)
        with desktop.expect_response(lambda response: response.url.endswith('/admin/users/' + participant_user['id'] + '/onboarding'), timeout=45000) as answers:
            desktop.goto(BASE + base_path + '&part=onboarding&userId=' + participant_user['id'])
        assert answers.value.ok
        expect(desktop.get_by_role('link', name='К списку участников', exact=True)).to_be_visible()
        check_layout(desktop)
        print('PASS 1440px admin invite clipboard and audit, settings and every Exchange tab', flush=True)

        tablet.goto(BASE + base_path + '&part=invites')
        expect(heading(tablet, 'Создать приглашения')).to_be_visible()
        expect(tablet.get_by_role('checkbox', name='Знаю лично')).to_have_count(0)
        check_sections(tablet, COMMON)
        shared_sections(tablet, moderator, administrator=False, buyer=buyer)
        for part in ['settings', 'rates', 'corridors', 'contact-blocks', 'telegram', 'data-requests', 'user-consents']:
            tablet.goto(BASE + base_path + '&part=' + part + '&userId=' + participant_user['id'])
            expect(heading(tablet, 'Модели оборудования')).to_be_visible()
            check_layout(tablet)
        for route in ['settings', 'fx-rates', 'corridors', 'contact-blocks', 'telegram', 'data-requests']:
            api(moderator, 'admin/' + route, status=403)
        api(moderator, 'admin/matches')
        api(moderator, f'admin/users/{participant_user["id"]}/onboarding')
        invite = api(moderator, 'admin/invites', 'POST', {'count': 1}, 201)['items'][0]
        api(moderator, f'admin/invites/{invite["id"]}/revoke', 'PATCH', {'reason': 'Проверка границы роли'})
        api(moderator, 'admin/invites', 'POST', {'count': 1, 'knownPersonally': True, 'note': 'Проверяем границу роли'}, 403)
        api(moderator, 'admin/settings/timezone', 'PUT', {'value': 'UTC'}, 403)
        api(moderator, 'admin/catalog-sync/sources/PCI_IDS', 'PUT', {'urls': ['https://pci-ids.ucw.cz/v2.2/pci.ids']}, 403)
        api(moderator, 'admin/catalog-sync/run', 'POST', {'source': 'PCI_IDS'}, 403)
        for route in ['disclosures', 'principals', 'jobs', 'models', 'verification']:
            api(buyer, 'admin/' + route, status=403)
        participant.goto(BASE + base_path + '&part=disclosures')
        expect(participant).to_have_url(BASE + '/catalog')
        expect(navigation(participant)).to_have_count(0)
        check_layout(participant)
        open_section(desktop, 'Настройки биржи', 'settings')
        change_setting(desktop, 'Рейтинг и проверка', 'feature_trust_rating', False)
        open_section(desktop, 'Проверки и сделки')
        expect(desktop.get_by_text('Проверка пока не включена.', exact=True)).to_be_visible()
        check_layout(desktop)
        assert not errors, errors
        print('PASS 768px moderator staff tabs, protected admin APIs and participant exclusion', flush=True)
    finally:
        api(admin, 'admin/settings/feature_trust_rating', 'PUT', {'value': original_trust})
        admin.close()
        moderator.close()
        buyer.close()


if __name__ == '__main__':
    expect.set_options(timeout=45000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            run(browser)
        finally:
            browser.close()
