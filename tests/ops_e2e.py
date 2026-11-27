"""Operations screens on a disposable, fresh maxv demo."""

import os

from playwright.sync_api import expect, sync_playwright

from contextual_moderation_e2e import BASE, activate_staff

CHROMIUM = os.getenv('CHROMIUM_PATH') or os.getenv('HWFORAI_QA_CHROMIUM')
EXCHANGE = '/admin?section=exchange&part='


def fit(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.url


def run(browser):
    admin = browser.new_context(viewport={'width': 1280, 'height': 900})
    moderator = browser.new_context(viewport={'width': 375, 'height': 812}, is_mobile=True, has_touch=True)
    page = admin.new_page()
    activate_staff(admin, moderator)
    errors = []
    page.on('pageerror', lambda cause: errors.append(str(cause)))
    page.goto(BASE + EXCHANGE + 'settings')
    page.get_by_text('Пресет «Проба»', exact=True).click()
    expect(page.get_by_role('button', name='Применить пресет')).to_be_disabled()
    expect(page.get_by_label('Курс KZT в USD')).to_be_visible()
    page.get_by_text('Готовность к приглашениям', exact=True).click()
    expect(page.get_by_text('Копия свежая, восстановление проверено')).to_be_visible()
    page.get_by_text('Тестовое письмо', exact=True).click()
    page.get_by_label('Адрес получателя').fill('ops-browser@example.test')
    page.get_by_role('button', name='Отправить тестовое письмо').click()
    expect(page.get_by_text('Тестовое письмо передано почтовому серверу.')).to_be_visible()
    fit(page)
    page.set_viewport_size({'width': 375, 'height': 812})
    fit(page)

    staff = moderator.new_page()
    staff.on('pageerror', lambda cause: errors.append(str(cause)))
    staff.goto(BASE + EXCHANGE + 'mail')
    expect(staff.get_by_role('heading', name='Письма и доставки')).to_be_visible()
    staff.get_by_role('button', name='Письма компаниям').click()
    expect(staff.get_by_role('button', name='Письма компаниям')).to_have_attribute('aria-pressed', 'true')
    expect(staff.get_by_label('Статус')).to_be_visible()
    fit(staff)
    staff.goto(BASE + EXCHANGE + 'jobs')
    staff.get_by_text('Ручной запуск', exact=True).click()
    run_button = staff.get_by_role('button', name='Запустить сейчас · Скрытие и архив')
    expect(staff.get_by_role('button', name='Запустить сейчас · Обновление справочника карт')).to_have_count(0)
    run_button.focus()
    staff.keyboard.press('Enter')
    expect(staff.get_by_text('Вручную', exact=False).first).to_be_visible()
    fit(staff)
    staff.set_viewport_size({'width': 1280, 'height': 900})
    fit(staff)
    assert not errors, errors
    print('PASS trial preview, SMTP UI, readiness, mail tabs, manual job permissions and keyboard (375/1280)', flush=True)
    admin.close()
    moderator.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM, headless=True, args=['--no-sandbox'])
        run(browser)
        browser.close()


if __name__ == '__main__':
    main()
