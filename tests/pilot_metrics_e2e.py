"""Exercise the pilot dashboard and CSV on a disposable maxv demo with Mailpit."""

from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from contextual_moderation_e2e import activate_staff, login
from exchange_admin_e2e import BASE, CHROMIUM, api, button, check_layout, heading


def verify_admin(page, admin):
    expect(heading(page, 'Показатели пробы')).to_be_visible()
    expect(page.get_by_role('img', name='Объявления в выдаче по дням', exact=True)).to_be_visible()
    expect(heading(page, 'Настройки пробы')).to_be_visible()

    page.locator('.pilot-filters').get_by_label('Дата окончания').fill('2026-11-25')
    button(page, 'Показать').click()
    expect(page.locator('.pilot-table tbody tr')).to_have_count(1)
    expect(page.locator('.pilot-table tbody')).to_contain_text('25.11.2026')

    page.get_by_label('Минимум живых совпадений').fill('4')
    button(page, 'Сохранить стоп-правило').click()
    expect(page.get_by_text('Настройка сохранена.', exact=True)).to_be_visible()
    expect(page.locator('.pilot-stop')).to_contain_text('из 4')

    page.get_by_label('Поиск по нику участника').fill('TechSupply')
    button(page, 'Найти').click()
    button(page, 'Исключить TechSupply из показателей').click()
    button(page, 'Сохранить исключения').click()
    expect(page.get_by_text('Настройка сохранена.', exact=True)).to_be_visible()
    assert [row['nickname'] for row in api(admin, 'admin/pilot-accounts')['items']] == ['TechSupply']
    check_layout(page)


def verify_moderator(page, moderator):
    expect(heading(page, 'Показатели пробы')).to_be_visible()
    expect(heading(page, 'Настройки пробы')).to_have_count(0)
    expect(page.locator('.pilot-chart')).to_be_hidden()
    expect(page.locator('.pilot-table')).to_be_visible()
    assert page.locator('.pilot-grid').first.evaluate("el => getComputedStyle(el).gridTemplateColumns.split(' ').length") == 1

    link = page.get_by_role('link', name='Выгрузить CSV', exact=True)
    link.focus()
    with page.expect_download() as download:
        page.keyboard.press('Enter')
    assert download.value.suggested_filename == 'pilot-metrics-2026-11-25-2026-12-08.csv'
    content = Path(download.value.path()).read_bytes()
    assert content.startswith(b'\xef\xbb\xbf')
    assert 'Дата;Подтверждено объявлений;' in content.decode('utf-8-sig')
    assert b'TechSupply' not in content
    api(moderator, 'admin/settings/stop_rule', 'PUT', {'value': {'date': '2026-12-08', 'minLiveMatches': 3}}, 403)
    api(moderator, 'admin/pilot-accounts?q=TechSupply', status=403)
    check_layout(page)


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        admin = browser.new_context(viewport={'width': 1440, 'height': 900})
        moderator = browser.new_context(viewport={'width': 375, 'height': 812}, accept_downloads=True, has_touch=True, is_mobile=True)
        member = browser.new_context()
        activate_staff(admin, moderator)
        desktop = admin.new_page()
        phone = moderator.new_page()
        for page in [desktop, phone]:
            page.goto(f'{BASE}/admin?section=exchange&part=pilot', wait_until='domcontentloaded')
        verify_admin(desktop, admin)
        verify_moderator(phone, moderator)
        login(member, 'test2', 'test2')
        api(member, 'admin/pilot-metrics', status=403)
        api(member, 'admin/pilot-metrics.csv', status=403)
        browser.close()
