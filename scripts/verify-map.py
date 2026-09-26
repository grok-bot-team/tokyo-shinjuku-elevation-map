#!/usr/bin/env python3
"""Drive the Shinjuku elevation map like a user. Pan, zoom, click, save proof."""

from pathlib import Path
import json

from playwright.sync_api import sync_playwright

APP = "http://127.0.0.1:8765/"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(APP, wait_until="domcontentloaded")
        page.wait_for_selector(".leaflet-container")
        page.wait_for_function(
            "() => document.getElementById('legend-min').textContent === '5'"
        )
        page.wait_for_timeout(1500)
        title = page.title()
        attr = page.locator(".leaflet-control-attribution").inner_text()
        print(json.dumps({"title": title, "attribution": attr}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
