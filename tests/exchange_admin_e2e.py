"""Exchange administration and seeded sign-ins on a disposable maxv demo instance.

Set HWFORAI_QA_BASE, HWFORAI_QA_MAILPIT_URL and optional CHROMIUM_PATH.
Start the instance with EXCHANGE_DEMO_FEATURES=true. The test changes the
administrator's initial password and creates a moderator.
"""

import os
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import complete_otp, login
from contextual_moderation_e2e import activate_staff

BASE = os.getenv('HWFORAI_QA_BASE', 'http://127.0.0.1:3000').rstrip('/')
CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
TAG = uuid4().hex[:8]
COMMON = ['Модели оборудования', 'Журнал раскрытий', 'Принципалы', 'Проверки и сделки', 'Фоновые задачи']
ADMIN_ONLY = ['Совпадения', 'Приглашения', 'Настройки биржи', 'Курсы валют', 'Ценовые ориентиры']


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


def models(page, administrator):
    open_section(page, 'Модели оборудования', 'models')
    expect(heading(page, 'Модели оборудования')).to_be_visible()
    expect(button(page, 'Добавить модель')).to_be_visible()
    for tab, path, marker in [('Обновления каталога', 'catalog-sync/items', 'Ожидают проверки:'),
                              ('Источники', 'catalog-sync/sources', 'База PCI ID')]:
        with page.expect_response(lambda response: urlsplit(response.url).path == '/api/v1/admin/' + path, timeout=45000) as reply:
            button(page, tab).click()
        assert reply.value.ok
        expect(page.get_by_text(marker, exact=False).first).to_be_visible()
        check_layout(page)
    if administrator:
        expect(button(page, 'Проверить сейчас').first).to_be_visible()
        expect(button(page, 'Изменить адреса').first).to_be_visible()
    else:
        expect(button(page, 'Проверить сейчас')).to_have_count(0)
        expect(button(page, 'Изменить адреса')).to_have_count(0)
    button(page, 'Прежние объявления').click()
    expect(button(page, 'Найти предложения моделей')).to_be_visible()
    check_layout(page)


def shared_sections(page, administrator):
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
    models(page, administrator)


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
    invite_id = invites(desktop, admin)
    original_trust = settings(desktop, admin)
    try:
        shared_sections(desktop, administrator=True)
        for name, route, marker in [('Совпадения', 'matches', desktop.get_by_label('Поиск совпадений', exact=True)),
                                    ('Курсы валют', 'fx-rates', heading(desktop, 'Курсы валют')),
                                    ('Ценовые ориентиры', 'corridors', heading(desktop, 'Коридоры цен'))]:
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
        expect(heading(tablet, 'Модели оборудования')).to_be_visible()
        check_sections(tablet, COMMON)
        shared_sections(tablet, administrator=False)
        for part in ['settings', 'matching', 'rates', 'corridors', 'onboarding']:
            tablet.goto(BASE + base_path + '&part=' + part + '&userId=' + participant_user['id'])
            expect(heading(tablet, 'Модели оборудования')).to_be_visible()
            check_layout(tablet)
        for route in ['invites', 'settings', 'matches', 'fx-rates', 'corridors']:
            api(moderator, 'admin/' + route, status=403)
        api(moderator, f'admin/users/{participant_user["id"]}/onboarding', status=403)
        api(moderator, 'admin/invites', 'POST', {'count': 1}, 403)
        api(moderator, f'admin/invites/{invite_id}/revoke', 'PATCH', {'reason': 'Проверка границы роли'}, 403)
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
