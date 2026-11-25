"""Playwright helpers for opening and selecting a country in a form or filter."""


def country_control(scope, name):
    return scope.get_by_role("combobox").and_(scope.locator(f'[data-country-field="{name}"]'))


def open_countries(scope, name):
    control = country_control(scope, name)
    control.click()
    list_id = control.get_attribute("aria-controls")
    return scope.locator(f'[id="{list_id}"]')


def choose_country(scope, name, code):
    open_countries(scope, name).locator(f'[role="option"][data-value="{code}"]').click()
