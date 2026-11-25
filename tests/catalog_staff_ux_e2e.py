"""Catalog geometry and role access on a disposable EXCHANGE_DEMO_FEATURES=true instance.

Set HWFORAI_QA_BASE, HWFORAI_QA_MAILPIT_URL and optionally CHROMIUM_PATH.
The test rotates the demo administrator password and creates moderation fixtures.
"""

import re
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from account_listing_e2e import mail_code
from contextual_moderation_e2e import BASE, CHROMIUM, activate_staff, api, login, publish


SHORTCUT = 'Управление категориями'
WIDTHS = (320, 390, 768, 1024, 1280, 1440, 2048)
OLD_ACTIONS = re.compile(r'Редактировать|Модерировать|Действия модерации')


def url(path, **params):
    return BASE + path + ('?' + urlencode(params) if params else '')


def assert_no_storefront_writes(page, staff):
    shortcut = page.get_by_role('link', name=SHORTCUT, exact=True)
    expect(shortcut).to_have_count(int(staff))
    if staff:
        expect(shortcut).to_be_visible()
        expect(shortcut).to_have_attribute('href', '/admin?section=categories')
    expect(page.get_by_role('button', name=OLD_ACTIONS)).to_have_count(0)
    expect(page.get_by_role('link', name=OLD_ACTIONS)).to_have_count(0)


def assert_filter_geometry(page):
    """Compare each visible filter surface with the sidebar and result rectangles."""
    panel = page.get_by_role('complementary', name='Фильтры каталога')
    toggle = page.locator('.mobile-filters')
    if toggle.is_visible() and not panel.is_visible():
        toggle.press('Enter')
        expect(toggle).to_have_attribute('aria-expanded', 'true')
    expect(panel).to_be_visible()

    extra = panel.locator('details.more-filters')
    if extra.get_attribute('open') is None:
        extra.locator('summary').press('Enter')

    measured = panel.evaluate("""(sidebar) => {
      const results = document.querySelector('.catalog-main').getBoundingClientRect()
      const limits = sidebar.getBoundingClientRect()
      const overflow = [...sidebar.querySelectorAll('select, input, button, label, summary, small')]
        .filter(element => element.getClientRects().length)
        .filter(element => {
          const box = element.getBoundingClientRect()
          return box.left < limits.left - 1 || box.right > limits.right + 1
        })
        .map(element => element.innerText || element.getAttribute('aria-label') || element.tagName)
      return {
        overflow,
        separate: limits.right <= results.left + 1 || limits.bottom <= results.top + 1,
        viewport: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
      }
    }""")
    assert not measured['overflow'], (page.url, measured)
    assert measured['separate'], (page.url, measured)
    assert measured['pageWidth'] <= measured['viewport'], (page.url, measured)


def verify_catalog(page, staff, empty_category, widths):
    page.goto(url('/catalog', category=empty_category, q='снаряжение без совпадений'))
    if staff:
        expect(page.get_by_role('heading', name='Объявления не найдены')).to_be_visible()
    else:
        expect(page.get_by_role('heading', name='Каталог оборудования')).to_be_visible()
        if empty_category and page.locator('.catalog-search').is_visible():
            expect(page.locator('.catalog-search input')).to_have_value('снаряжение без совпадений')

    for width in widths:
        page.set_viewport_size({'width': width, 'height': 900})
        assert_no_storefront_writes(page, staff)
        assert_filter_geometry(page)


def run(browser):
    admin = browser.new_context(viewport={'width': 1440, 'height': 900})
    moderator = browser.new_context(viewport={'width': 768, 'height': 900}, has_touch=True)
    buyer = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    seller = browser.new_context(viewport={'width': 1280, 'height': 900})
    agent = browser.new_context(viewport={'width': 768, 'height': 900}, has_touch=True)
    guest = browser.new_context(viewport={'width': 320, 'height': 720}, is_mobile=True, has_touch=True)
    activate_staff(admin, moderator)
    login(seller, 'test1', 'test1')
    login(buyer, 'test2', 'test2')
    challenge = login(agent, 'testagent', 'Agent-Maxv-2026!')
    assert api(agent, 'auth/verify', 'POST', {
        'challengeId': challenge['challengeId'],
        'code': mail_code('testagent@example.test'),
    })['user']['role'] == 'SELLER'

    tag = uuid4().hex[:8]
    slug = 'qa-catalog-' + tag
    long_name = 'Комплектующие для масштабируемых серверных систем с распределёнными вычислениями и резервированием ' + tag
    category = api(admin, 'admin/categories', 'POST', {'name': long_name, 'slug': slug, 'sortOrder': 0})
    hidden = api(admin, 'admin/categories', 'POST', {'name': 'Скрытая категория ' + tag, 'slug': slug + '-hidden', 'active': False})
    offer_title = 'QA предложение ' + tag
    offer_id = publish(seller, category['id'], offer_title, 'SELL')

    desktop = admin.new_page()
    errors = []
    desktop.on('pageerror', lambda error: errors.append(str(error)))
    verify_catalog(desktop, True, 'cpu', (1024, 1440))
    verify_catalog(desktop, True, slug, WIDTHS)
    # 200% zoom on a typical desktop leaves an effective CSS viewport near 720px.
    verify_catalog(desktop, True, slug, (720,))
    panel = desktop.get_by_role('complementary', name='Фильтры каталога')
    expect(panel.get_by_role('combobox', name='Категория', exact=True)).to_have_value(slug)
    expect(panel.get_by_role('combobox', name='Категория', exact=True).locator(f'option[value="{hidden["slug"]}"]')).to_have_count(0)
    expect(panel.get_by_role('combobox', name='Модель', exact=True).locator('option[value=""]')).to_have_text('Все модели')
    desktop.goto(url('/catalog', category=hidden['slug']))
    expect(desktop.get_by_role('heading', name='Каталог оборудования')).to_be_visible()
    if desktop.locator('.mobile-filters').is_visible():
        desktop.locator('.mobile-filters').click()
    retired = desktop.get_by_role('combobox', name='Категория', exact=True).locator('option:checked')
    expect(retired).to_have_text('Категория недоступна')
    assert retired.evaluate('(option) => option.disabled')
    desktop.get_by_role('button', name='Сбросить', exact=True).click()
    expect(desktop.get_by_role('combobox', name='Категория', exact=True)).to_have_value('')
    print('PASS catalog sidebar containment at 320–2048 px, long labels and empty result', flush=True)

    desktop.goto(BASE + '/')
    expect(desktop.locator('.category-tile').first).to_be_visible()
    assert_no_storefront_writes(desktop, True)
    desktop.get_by_role('link', name=SHORTCUT, exact=True).click()
    expect(desktop.get_by_role('heading', name='Категории', exact=True)).to_be_visible()
    expect(desktop.get_by_role('row').filter(has_text=long_name).get_by_role('button', name='Редактировать', exact=True)).to_be_visible()
    expect(desktop.get_by_role('row').filter(has_text=hidden['name']).get_by_text('Скрыта', exact=True)).to_be_visible()
    print('PASS one category management shortcut with centralized active and hidden rows', flush=True)

    for context, expected_staff, widths in [
        (moderator, True, (390, 768, 1280)),
        (buyer, False, (390, 1024)),
        (seller, False, (320, 1280)),
        (agent, False, (768, 1280)),
        (guest, False, (320, 768)),
    ]:
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        verify_catalog(page, expected_staff, slug, widths)
        assert context.request.get(BASE + '/api/v1/admin/categories').status == (
            200 if expected_staff else 401 if context is guest else 403
        )
        if context is guest:
            expect(page.get_by_role('heading', name='Войдите, чтобы увидеть объявления')).to_be_visible()
        page.close()
    print('PASS staff shortcut and API roles at mobile, tablet and desktop', flush=True)

    # Real nonempty catalog, navigation and return path.
    catalog = url('/catalog', category=slug, q=tag, showAll='true')
    desktop.goto(catalog)
    heading = desktop.get_by_role('heading', name=offer_title, exact=True)
    expect(heading).to_be_visible()
    assert_no_storefront_writes(desktop, True)
    heading.click()
    expect(desktop).to_have_url(BASE + '/listings/' + offer_id)
    actions = desktop.get_by_role('button', name='Действия модерации', exact=True)
    expect(actions).to_have_count(1)
    actions.press('Enter')
    dialog = desktop.get_by_role('dialog')
    listing_action = dialog.get_by_role('button', name='Модерировать объявление', exact=True)
    expect(listing_action).to_be_focused()
    expect(dialog.get_by_role('button', name='Модерировать профиль', exact=True)).to_be_visible()
    listing_action.press('Enter')
    expect(dialog.get_by_role('heading', name=offer_title, exact=True)).to_be_focused()
    dialog.get_by_role('button', name='К списку действий', exact=True).press('Enter')
    expect(listing_action).to_be_focused()
    desktop.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(actions).to_be_focused()
    desktop.get_by_role('link', name='К каталогу', exact=True).click()
    expect(heading).to_be_visible()
    assert parse_qs(urlsplit(desktop.url).query) == parse_qs(urlsplit(catalog).query)

    customer = buyer.new_page()
    customer.goto(BASE + '/listings/' + offer_id)
    expect(customer.get_by_role('heading', name=offer_title, exact=True)).to_be_visible()
    expect(customer.get_by_role('button', name=OLD_ACTIONS)).to_have_count(0)
    expect(customer.get_by_text('Документы проверены', exact=True)).to_be_visible()
    assert not errors, errors
    print('PASS listing-only moderation, keyboard/focus, filtered return and verification text', flush=True)


if __name__ == '__main__':
    expect.set_options(timeout=20000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        try:
            run(browser)
        finally:
            browser.close()
