"""Desktop and mobile dispute workflow with a real demo API and Mailpit."""

import os
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from contextual_moderation_e2e import BASE, activate_staff, api, button, login

CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
QUEUE = '/admin?section=exchange&part=disputes'


def fit(page, dialog=None):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.url
    if dialog is not None:
        assert dialog.evaluate('(dialog) => dialog.scrollWidth <= dialog.clientWidth'), page.url


def enable(admin, key, value):
    api(admin, 'admin/settings/' + key, 'PUT', {'value': value})


def disclosure(admin, seller, buyer):
    for key, value in {
        'feature_disclosure_journal': True, 'feature_disputes': True,
        'feature_trust_rating': False, 'feature_actuality': False, 'disclosure_min_level': 0,
        'disclosure_requires_verified_telegram': False,
    }.items():
        enable(admin, key, value)
    title = 'NVIDIA H100 для проверки споров ' + uuid4().hex[:8]
    category = next(item for item in api(seller, 'categories') if item['slug'] == 'gpu')
    listing = api(seller, 'listings', 'POST', {
        'title': title, 'description': 'Предложение для проверки процедуры разрешения спора.',
        'categoryId': category['id'], 'modelId': 'h100-sxm', 'availability': 'STOCK',
        'originCountry': 'RU', 'stockCity': 'Казань', 'quantity': 3, 'condition': 'NEW',
    })
    chat = api(buyer, 'chats', 'POST', {'listingId': listing['id']})
    path = f'chats/{chat["id"]}/reveal'
    consent = api(buyer, path, 'PATCH', {'action': 'REQUEST', 'rulesAccepted': True})
    api(seller, path, 'PATCH', {'action': 'ACCEPT', 'requestId': consent['revealRequestId'], 'rulesAccepted': True})
    return next(record['id'] for record in api(buyer, 'disclosures')['items'] if record['chatId'] == chat['id'])


def run(browser):
    buyer_context = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    seller_context = browser.new_context(viewport={'width': 1280, 'height': 840})
    admin_context = browser.new_context(viewport={'width': 1280, 'height': 840})
    moderator_context = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    activate_staff(admin_context, moderator_context)
    login(buyer_context, 'test2', 'test2')
    login(seller_context, 'test1', 'test1')
    source = disclosure(admin_context, seller_context, buyer_context)

    buyer = buyer_context.new_page()
    seller = seller_context.new_page()
    mod = moderator_context.new_page()
    admin = admin_context.new_page()
    errors = []
    for page in [buyer, seller, mod, admin]:
        page.on('pageerror', lambda error: errors.append(str(error)))
    buyer.goto(BASE + '/disclosures/' + source)
    trigger = button(buyer, 'Открыть спор')
    expect(trigger).to_be_visible()
    trigger.press('Enter')
    wizard = buyer.get_by_role('dialog', name='Открыть спор')
    expect(wizard).to_be_visible()
    fit(buyer, wizard)
    buyer.keyboard.press('Escape')
    expect(trigger).to_be_focused()
    trigger.press('Enter')
    wizard.get_by_label('Причина спора').select_option('MISREPRESENTATION')
    wizard.get_by_label('Опишите, что случилось').fill('Количество оборудования в счёте отличается от согласованного.')
    wizard.get_by_label('Какого результата вы ожидаете').fill('Уточнить количество и условия поставки.')
    button(wizard, 'Подать спор').click()
    expect(buyer.get_by_text('Уведомить до', exact=True)).to_be_visible()
    dispute_path = buyer.url.removeprefix(BASE)
    dispute_id = dispute_path.split('/')[-1]
    assert dispute_path == '/disputes/' + dispute_id
    fit(buyer)

    mod.goto(BASE + QUEUE)
    list_button = mod.get_by_role('button', name=buyer.get_by_role('heading', name='Спор №').inner_text().replace('Спор №', 'Открыть спор №'))
    expect(list_button).to_be_visible()
    list_button.press('Enter')
    detail = mod.get_by_role('dialog', name='Карточка спора')
    expect(detail.get_by_text('Уведомить до', exact=True)).to_be_visible()
    fit(mod, detail)
    mod.keyboard.press('Escape')
    expect(list_button).to_be_focused()
    list_button.press('Enter')
    button(detail, 'Уведомить вторую сторону').click()
    expect(detail.get_by_text('Материалы до', exact=True)).to_be_visible()

    seller.goto(BASE + dispute_path)
    seller.get_by_label('Ваша позиция').fill('Готов пересчитать предложение и приложить счёт.')
    button(seller, 'Сохранить позицию').click()
    seller.get_by_label('Файл').set_input_files({
        'name': 'Сводка.txt', 'mimeType': 'text/plain', 'buffer': 'Итоговые условия поставки.'.encode(),
    })
    button(seller, 'Добавить материал').click()
    expect(seller.get_by_role('link', name='Сводка.txt')).to_be_visible()
    fit(seller)

    button(detail, 'Начать разбор').click()
    expect(detail.get_by_text('Решение до', exact=True)).to_be_visible()
    button(detail, 'Решить').press('Enter')
    decision = mod.get_by_role('dialog', name='Решение по спору')
    expect(decision).to_be_visible()
    fit(mod, decision)
    mod.keyboard.press('Escape')
    expect(button(detail, 'Решить')).to_be_focused()
    button(detail, 'Решить').press('Enter')
    expect(decision).to_be_visible()
    party = api(seller_context, 'auth/me')['user']['id']
    decision.get_by_role('combobox', name='Решение').select_option('MISREPRESENTATION')
    decision.get_by_label('Проигравшая сторона').select_option(party)
    decision.get_by_label('Обоснование').fill('Выставленный счёт не соответствует предложению продавца.')
    button(decision, 'Сохранить решение').click()
    expect(detail.get_by_role('heading', name='Решение оператора')).to_be_visible()

    seller.reload()
    seller.get_by_label('Новые доводы для пересмотра').fill('Приложена выписка о согласовании другой партии по отдельному счёту.')
    button(seller, 'Подать запрос на пересмотр').click()
    expect(seller.get_by_role('heading', name='Доводы для пересмотра')).to_be_visible()
    admin.goto(BASE + QUEUE + '&dispute=' + dispute_id)
    case = admin.get_by_role('dialog', name='Карточка спора')
    expect(case.get_by_text('Решение до', exact=True)).to_be_visible()
    button(case, 'Решить').click()
    review = admin.get_by_role('dialog', name='Решение по спору')
    fit(admin, review)
    review.get_by_label('Обоснование').fill('Документы пересмотра подтверждают наличие отдельной партии.')
    button(review, 'Сохранить решение').click()
    expect(case.get_by_role('heading', name='Окончательное решение')).to_be_visible()
    buyer.reload()
    expect(buyer.get_by_role('heading', name='Окончательное решение')).to_be_visible()
    fit(buyer)
    assert not errors, errors
    print('PASS disputes: mobile disclosure form and moderator decision, desktop evidence and administrator reconsideration')


if __name__ == '__main__':
    expect.set_options(timeout=20000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        run(browser)
        browser.close()
