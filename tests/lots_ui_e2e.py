"""Exercise lot groups against a running maxv demo backed by a disposable PostgreSQL database."""

import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('HWFORAI_URL', '').rstrip('/')
CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
SCREENSHOTS = os.getenv('HWFORAI_SCREENSHOTS')
ROOT = Path(__file__).resolve().parents[1]


def prepare_fixture():
    origin = urlsplit(BASE)
    if origin.scheme not in ('http', 'https') or origin.hostname not in ('127.0.0.1', '::1', 'localhost'):
        raise SystemExit('Set HWFORAI_URL to the origin of a disposable local demo')
    if not os.getenv('HWFORAI_LOTS_TEST_DATABASE_URL'):
        raise SystemExit('Set HWFORAI_LOTS_TEST_DATABASE_URL to the disposable database serving that demo')
    run = subprocess.run(
        ['node', str(ROOT / 'server/test/lots-browser-fixture.cjs')],
        cwd=ROOT, capture_output=True, text=True,
    )
    if run.returncode:
        raise RuntimeError(run.stderr.strip() or 'Could not prepare the disposable lot fixture')
    return json.loads(run.stdout)


def signed_in_page(browser, fixture, role, width, errors):
    context = browser.new_context(
        viewport={'width': width, 'height': 850}, is_mobile=width == 375, has_touch=width == 375,
    )
    context.add_cookies([{'name': 'hwforai_session', 'url': BASE, 'value': fixture['tokens'][role]}])
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    return context, page


def assert_fit(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.url


def buyer_catalog(page, fixture):
    page.goto(BASE + '/catalog?' + urlencode({'q': fixture['query']}))
    expect(page.locator('.lot-catalog-card')).to_have_count(1)
    expect(page.get_by_text('предлагают 2 участника')).to_be_visible()
    expect(page.get_by_text(fixture['alternativeTitle'])).to_have_count(0)
    reveal = page.get_by_role('button', name='Ещё одно предложение этого лота', exact=True)
    reveal.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_role('button', name='Свернуть предложения', exact=True)).to_have_attribute('aria-expanded', 'true')
    expect(page.get_by_role('link', name=fixture['alternativeTitle'])).to_be_visible()
    expect(page.get_by_text(fixture['alternativeName'])).to_be_visible()


def seller_listings(page, fixture):
    page.goto(BASE + '/my-listings')
    expect(page.get_by_text('Похожее предложение есть у другого участника', exact=False)).to_be_visible()
    expect(page.get_by_text(fixture['alternativeName'])).to_have_count(0)


def moderator_group(page, fixture, width):
    page.goto(BASE + '/admin?section=exchange&part=lots&lot=' + fixture['lotId'])
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_role('table')).to_be_visible()
    expect(dialog.get_by_text(fixture['alternativeTitle'])).to_be_visible()
    if width == 375:
        table = dialog.get_by_role('region', name='Участники лота')
        assert table.evaluate('(element) => element.scrollWidth > element.clientWidth')
    dialog.get_by_role('button', name='Оставить главной').click()
    expect(dialog.get_by_label('Главная карточка')).to_be_visible()
    expect(dialog.get_by_label('Причина')).to_have_attribute('required', '')
    assert dialog.locator('form').evaluate('(element) => element === document.activeElement')
    return dialog


def appeal_and_restore(browser, fixture, errors):
    context, page = signed_in_page(browser, fixture, 'seller', 375, errors)
    reason = 'Поставка входит в самостоятельную партию.'
    try:
        page.goto(BASE + '/my-listings')
        item = page.locator('.workflow-own-item').filter(has_text=fixture['primaryTitle'])
        expect(item.get_by_text('Дубль', exact=True)).to_be_visible()
        item.get_by_role('button', name='Оспорить').click()
        appeal = page.get_by_role('dialog')
        appeal.get_by_label('Причина').fill(reason)
        appeal.get_by_role('button', name='Отправить модератору').click()
        expect(item.get_by_text('Оспаривание ожидает рассмотрения')).to_be_visible()
        assert_fit(page)
    finally:
        context.close()

    context, page = signed_in_page(browser, fixture, 'moderator', 375, errors)
    try:
        page.goto(BASE + '/admin?section=exchange&part=lots&lot=' + fixture['lotId'])
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_text(reason, exact=False)).to_be_visible()
        dialog.get_by_role('button', name='Вернуть дубль').click()
        dialog.get_by_label('Причина').fill('Подтверждена отдельная партия.')
        dialog.get_by_role('button', name='Подтвердить', exact=True).click()
        expect(dialog.get_by_role('button', name='Вернуть дубль')).to_have_count(0)
        assert_fit(page)
    finally:
        context.close()
    print('PASS lot resolution, appeal and restoration', flush=True)


def run(browser, fixture):
    errors = []
    for width in (375, 1440):
        for role in ('buyer', 'seller', 'moderator'):
            context, page = signed_in_page(browser, fixture, role, width, errors)
            try:
                if role == 'buyer':
                    buyer_catalog(page, fixture)
                elif role == 'seller':
                    seller_listings(page, fixture)
                else:
                    dialog = moderator_group(page, fixture, width)
                    if width == 1440:
                        dialog.get_by_label('Главная карточка').select_option(fixture['alternativeListingId'])
                        dialog.get_by_label('Причина').fill('Склад сообщил распределение поставки.')
                        dialog.get_by_role('button', name='Подтвердить', exact=True).click()
                        expect(dialog.get_by_text('Решение принято', exact=False)).to_be_visible()
                assert_fit(page)
                if SCREENSHOTS:
                    directory = Path(SCREENSHOTS)
                    directory.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(directory / f'lots-{role}-{width}.png'), animations='disabled')
            finally:
                context.close()
            print(f'PASS lots UI {role} {width}px', flush=True)

    appeal_and_restore(browser, fixture, errors)
    assert not errors, errors


if __name__ == '__main__':
    expect.set_options(timeout=45000)
    fixture = prepare_fixture()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROMIUM, headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'],
        )
        try:
            run(browser, fixture)
        finally:
            browser.close()
