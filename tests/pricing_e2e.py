"""Check mandatory models, input totals and catalog unit prices on a disposable demo."""
import os
import re
from urllib.parse import urlencode
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from model_catalog_e2e import check_layout, login

BASE = os.getenv('HWFORAI_URL', 'http://127.0.0.1:3000').rstrip('/')


def check_catalog(page, title, query):
    page.goto('/catalog?' + urlencode({'q': query, 'showAll': 'true'}))
    card = page.locator('.listing-card').filter(has_text=title)
    expect(card).to_be_visible()
    expect(card.locator('.listing-price')).to_have_text(re.compile(r'1\s890\s000\s₽ за шт\.'))
    expect(card.get_by_text(re.compile(r'15\s120\s000\s₽ за 8 шт\.'))).to_be_visible()
    expect(card.get_by_text(re.compile(r'19\s845 USD за шт\.'))).to_be_visible()
    check_layout(page)
    card.click()
    expect(page.get_by_role('heading', name=title)).to_be_visible()
    expect(page.locator('.detail-price')).to_have_text(re.compile(r'1\s890\s000\s₽ за шт\.'))
    check_layout(page)


def main():
    expect.set_options(timeout=15000)
    query = 'priceqa' + uuid4().hex[:8]
    title = 'NVIDIA H100 ' + query
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH'), headless=True,
                                             args=['--no-sandbox', '--disable-dev-shm-usage'])
        mobile = browser.new_context(base_url=BASE, viewport={'width': 375, 'height': 812},
                                     is_mobile=True, has_touch=True)
        seller = mobile.new_page()
        errors = []
        seller.on('pageerror', lambda error: errors.append(str(error)))
        login(seller, 'test1')
        seller.goto('/listings/new')
        categories = seller.request.get('/api/v1/categories').json()
        gpu = next(category['id'] for category in categories if category['slug'] == 'gpu')
        seller.locator('select[name="categoryId"]').select_option(gpu)
        seller.locator('input[name="title"]').fill(title)
        model = seller.get_by_role('combobox', name=re.compile('Модель по справочнику'))
        expect(model).to_have_attribute('required', '')
        expect(seller.get_by_role('group', name='Уточните модель')).to_be_visible()
        model.select_option('h100-sxm')
        seller.locator('input[name="quantity"]').fill('8')
        expect(seller.get_by_text('Цена за шт.', exact=True)).to_be_visible()
        seller.locator('input[name="price"]').fill('1890000')
        expect(seller.get_by_text(re.compile(r'За 8 шт\.: 15\s120\s000\s₽'))).to_be_visible()
        seller.locator('textarea[name="description"]').fill('Тестовое предложение для проверки цены за одну единицу.')
        seller.locator('input[name="stockCity"]').fill('Москва')
        check_layout(seller)
        with seller.expect_response(lambda result: result.url.endswith('/api/v1/listings')
                                    and result.request.method == 'POST', timeout=45000) as response:
            seller.get_by_role('button', name='Опубликовать объявление', exact=True).click()
        assert response.value.ok, response.value.text()
        listing = response.value.json()
        assert listing['priceUsd'] == 19_845
        assert listing['totalPrice'] == 15_120_000
        for width in (375, 1440):
            context = browser.new_context(base_url=BASE, viewport={'width': width, 'height': 900},
                                          is_mobile=width == 375, has_touch=width == 375)
            buyer = context.new_page()
            buyer.on('pageerror', lambda error: errors.append(str(error)))
            login(buyer, 'test2')
            check_catalog(buyer, title, query)
            context.close()
        assert not errors, errors
        browser.close()
    print('PASS mandatory model choice, quantity totals and RUB/USD pricing on mobile and desktop')


if __name__ == '__main__':
    main()
