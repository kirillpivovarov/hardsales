"""Model picker, legacy spec preservation and catalogue filter in Chromium.

Use a disposable demo instance with HWFORAI_URL and optional CHROMIUM_PATH.
"""

import os
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

BASE = os.getenv('HWFORAI_URL', 'http://127.0.0.1:3000').rstrip('/')


def login(page, name):
    page.goto('/login')
    page.locator('input[name="login"]').fill(name)
    page.locator('input[name="password"]').fill(name)
    with page.expect_response(lambda response: response.url.endswith('/api/v1/auth/login'), timeout=45000) as matched:
        page.get_by_role('button', name='Войти', exact=True).click()
    assert matched.value.ok, matched.value.text()
    expect(page.get_by_role('link', name='Разместить объявление', exact=True)).to_be_visible()


def check_layout(page):
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), page.url


def main():
    expect.set_options(timeout=12000)
    tag = 'modelqa' + uuid4().hex[:8]
    title = f'Серверный GPU Н200 SXM {tag}'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'), headless=True,
                                              args=['--no-sandbox', '--disable-dev-shm-usage'])
        mobile = browser.new_context(base_url=BASE, viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
        desktop = browser.new_context(base_url=BASE, viewport={'width': 1440, 'height': 980})
        seller, buyer = mobile.new_page(), desktop.new_page()
        errors = []
        for page in (seller, buyer):
            page.on('pageerror', lambda error: errors.append(str(error)))
        login(seller, 'test1')
        categories = seller.request.get('/api/v1/categories').json()
        gpu = next(category['id'] for category in categories if category['slug'] == 'gpu')
        seller.goto('/listings/new')
        seller.locator('select[name="categoryId"]').select_option(gpu)
        seller.locator('input[name="title"]').fill(title)
        seller.locator('input[name="spec:Модель"]').fill('Комплектация продавца')
        suggestion = seller.get_by_text(re.compile(r'Похоже на .*H200.*SXM'))
        expect(suggestion).to_be_visible()
        seller.get_by_role('button', name='Выбрать', exact=True).click()
        expect(seller.get_by_role('combobox', name=re.compile('Модель по справочнику'))).to_have_value('h200-sxm')
        expect(seller.locator('input[name="spec:Модель"]')).to_have_value('Комплектация продавца')
        expect(seller.locator('input[name="spec:Видеопамять"]')).to_have_value('141 ГБ')
        seller.locator('textarea[name="description"]').fill('Проверка публикации предложения с выбранной моделью.')
        seller.locator('select[name="priceMode"]').select_option('NEGOTIABLE')
        seller.locator('input[name="stockCity"]').fill('Москва')
        check_layout(seller)
        with seller.expect_response(lambda response: response.url.endswith('/api/v1/listings') and response.request.method == 'POST') as result:
            seller.get_by_role('button', name='Опубликовать объявление', exact=True).click()
        assert result.value.ok, result.value.text()
        listing = result.value.json()
        assert listing['modelId'] == 'h200-sxm' and listing['model']['nameRu']
        assert listing['specs']['Модель'] == 'Комплектация продавца'
        login(buyer, 'test2')
        buyer.goto('/catalog?category=gpu&model=h200-sxm&q=' + tag)
        expect(buyer.locator('.listing-card').filter(has_text=title)).to_be_visible()
        expect(buyer.locator('.listing-card')).to_have_count(1)
        check_layout(buyer)
        assert not errors, errors
        browser.close()
        print('PASS mobile seller model suggestion and preserved manual specs; desktop buyer model with text and category filters')


if __name__ == '__main__':
    main()
