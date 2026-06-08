const fs = require('fs');

function getChromium() {
  return require('playwright').chromium;
}

const LIST_URL = 'https://www.instacart.com/store/aldi/list/283885c9-44cb-4ea1-a693-6fab6ad92368';
const SEARCH_URL = 'https://www.instacart.com/store/aldi/search';
const STORAGE_STATE_PATH = './storage-state.json';
const RULES_PATH = './grocery-rules.json';
const SEARCH_RESULT_LIMIT = 12;
const MIN_ACCEPTABLE_SCORE = 28;
const EXPECTED_LIST_COUNT = 20;
const SCRIPT_VERSION = '2026-03-22-direct-search-input';

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (error) {
    console.warn(`Warning: could not read ${RULES_PATH}: ${error.message}`);
    return { defaultMinConfidence: 0.9, items: [] };
  }
}

const rules = loadRules();

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;

    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(text);
  }

  return result;
}

function isDollarOnly(line) {
  return /^\$\d+(\.\d+)?$/.test(line);
}

function isPriceLine(line) {
  const lower = String(line || '').toLowerCase();
  return (
    lower.startsWith('current price:') ||
    lower.startsWith('original price:') ||
    lower.startsWith('sale price:') ||
    lower.includes('% off') ||
    lower.includes('/lb') ||
    lower.includes('/ oz') ||
    lower.includes('each (est.)') ||
    lower.includes('member price') ||
    isDollarOnly(line)
  );
}

function isStockLine(line) {
  return ['Many in stock', 'Out of stock', 'Low stock'].includes(String(line || '').trim());
}

function isQtyLine(line) {
  return /^\d+(\.\d+)?\s+(ct|lb)$/i.test(line) || /^\d+(\.\d+)?\s+each$/i.test(line);
}

function isAboutLine(line) {
  return /^About\s/i.test(line);
}

function isShowSimilar(line) {
  return normalizeText(line) === 'show similar';
}

function isLikelySizeLine(line) {
  if (!line) return false;
  if (isPriceLine(line) || isStockLine(line) || isQtyLine(line) || isShowSimilar(line) || isAboutLine(line)) {
    return false;
  }

  return (
    /\b\d+(\.\d+)?\s*(ct|oz|fl oz|lb)\b/i.test(line) ||
    /\bcontainer\b/i.test(line) ||
    /\beach\b/i.test(line)
  );
}

function isLikelyUiNoiseLine(line) {
  const normalized = normalizeText(line);
  if (!normalized) return true;

  const exactMatches = new Set([
    'edit items',
    'add all to cart',
    'item preferences',
    'sort',
    'filter',
    'featured',
    'pickup',
    'delivery',
    'keep shopping',
    'continue shopping',
    'popular near you',
    'shop all',
    'buy it again',
    'you might also like',
    'recommended for you',
    'shop your favorites'
  ]);

  if (exactMatches.has(normalized)) {
    return true;
  }

  return (
    normalized.startsWith('search') ||
    normalized.startsWith('cart') ||
    normalized.startsWith('schedule') ||
    normalized.startsWith('help') ||
    normalized.startsWith('department') ||
    normalized.startsWith('aisles') ||
    normalized.startsWith('promotions') ||
    normalized.startsWith('saved ') ||
    normalized.startsWith('list ') ||
    normalized.endsWith(' results') ||
    normalized.includes('sign out')
  );
}

function looksLikeProductName(line) {
  if (!line) return false;
  if (isLikelyUiNoiseLine(line)) return false;
  if (isPriceLine(line)) return false;
  if (isStockLine(line)) return false;
  if (isQtyLine(line)) return false;
  if (isShowSimilar(line)) return false;
  if (isAboutLine(line)) return false;
  return true;
}

function parseItems(lines) {
  const items = [];
  let current = null;

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || isLikelyUiNoiseLine(line)) continue;

    if (looksLikeProductName(line)) {
      if (current && (current.stock || current.qty || current.size)) {
        items.push(current);
        current = null;
      }

      if (!current) {
        current = {
          name: line,
          size: '',
          stock: '',
          qty: '',
          showSimilar: false
        };
        continue;
      }
    }

    if (!current) continue;

    if (isLikelySizeLine(line) && !current.size) {
      current.size = line;
      continue;
    }

    if (isStockLine(line) && !current.stock) {
      current.stock = line;
      continue;
    }

    if (isQtyLine(line) && !current.qty) {
      current.qty = line;
      continue;
    }

    if (isShowSimilar(line)) {
      current.showSimilar = true;
    }
  }

  if (current) {
    items.push(current);
  }

  return dedupeParsedItems(items);
}

function dedupeParsedItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = [normalizeText(item.name), normalizeText(item.qty), normalizeText(item.size)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function ruleMatchesItemName(itemName, rule) {
  const name = normalizeText(itemName);
  const matchTerms = Array.isArray(rule?.match) ? rule.match : [];
  const excludeTerms = Array.isArray(rule?.exclude) ? rule.exclude : [];

  const hasMatch = matchTerms.some((term) => name.includes(normalizeText(term)));
  if (!hasMatch) return false;

  const hasExclude = excludeTerms.some((term) => name.includes(normalizeText(term)));
  return !hasExclude;
}

function findRuleForItem(item) {
  for (const rule of Array.isArray(rules.items) ? rules.items : []) {
    if (ruleMatchesItemName(item?.name, rule)) {
      return rule;
    }
  }

  return null;
}

function buildPurchaseItems(items) {
  return items.map((item, index) => {
    const rule = findRuleForItem(item);
    return {
      index: index + 1,
      name: item.name,
      qty: item.qty || '',
      size: item.size || '',
      stock: item.stock || '',
      label: rule?.label || 'unmatched',
      rule: rule
        ? {
            label: rule.label || 'unmatched',
            match: Array.isArray(rule.match) ? rule.match : [],
            exclude: Array.isArray(rule.exclude) ? rule.exclude : []
          }
        : null
    };
  });
}

function buildSearchTerms(item) {
  const terms = [item.name];

  if (item.rule?.match?.length) {
    terms.push(...item.rule.match);
  }

  if (item.size && !/unknown/i.test(item.size)) {
    terms.push(`${item.name} ${item.size}`);
  }

  return uniqueStrings(terms);
}

function textContainsExcludedTerm(text, item) {
  const haystack = normalizeText(text);
  const excludeTerms = Array.isArray(item.rule?.exclude) ? item.rule.exclude : [];
  return excludeTerms.some((term) => haystack.includes(normalizeText(term)));
}

function scoreCandidateText(text, item) {
  const normalizedCard = normalizeText(text);
  const normalizedName = normalizeText(item.name);
  const itemTokens = tokenize(item.name);
  const matchTerms = uniqueStrings([item.name, ...(item.rule?.match || [])]);
  let score = 0;

  if (!normalizedCard) return -999;
  if (normalizedCard === normalizedName) score += 150;
  if (normalizedCard.includes(normalizedName)) score += 100;

  for (const term of matchTerms) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) continue;

    if (normalizedCard === normalizedTerm) score += 80;
    else if (normalizedCard.includes(normalizedTerm)) score += 45;
  }

  for (const token of itemTokens) {
    if (normalizedCard.includes(token)) {
      score += token.length >= 5 ? 12 : 7;
    }
  }

  if (item.size) {
    const normalizedSize = normalizeText(item.size);
    if (normalizedSize && normalizedCard.includes(normalizedSize)) {
      score += 25;
    }
  }

  if (item.qty) {
    const normalizedQty = normalizeText(item.qty);
    if (normalizedQty && normalizedCard.includes(normalizedQty)) {
      score += 8;
    }
  }

  if (textContainsExcludedTerm(text, item)) {
    score -= 140;
  }

  return score;
}

function getFirstUsefulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !isPriceLine(line) && !isStockLine(line) && !isLikelyUiNoiseLine(line)) || '';
}

function extractProductNameFromAddAriaLabel(ariaLabel) {
  const label = String(ariaLabel || '').trim();
  if (!label) return '';

  const withoutAdd = label.replace(/^Add\s+/i, '');
  return withoutAdd.replace(/^(?:About\s+)?\d+(?:\.\d+)?\s+(?:ct|lb|each|oz|fl oz)\s+/i, '').trim();
}

function trimListSectionText(bodyText) {
  const startMarkers = ['Edit items', 'Add all to cart'];
  const endMarkers = [
    'Buy it again',
    'Shop your favorites',
    'Recommended for you',
    'Popular near you',
    'You might also like'
  ];

  let usefulText = bodyText;

  for (const marker of startMarkers) {
    const index = usefulText.indexOf(marker);
    if (index !== -1) {
      usefulText = usefulText.slice(index + marker.length);
      break;
    }
  }

  for (const marker of endMarkers) {
    const index = usefulText.indexOf(marker);
    if (index !== -1) {
      usefulText = usefulText.slice(0, index);
      break;
    }
  }

  return usefulText;
}

async function getListItemsFromPage(page) {
  const bodyText = await page.locator('body').innerText();
  const usefulText = trimListSectionText(bodyText);
  const lines = usefulText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return parseItems(lines);
}

async function waitForBlockingOverlaysToClear(page) {
  const overlaySelectors = [
    '[data-testid="loading-generic-on-enter"]',
    '[data-dialog-ref="loading"]',
    '[aria-busy="true"]'
  ];

  for (const selector of overlaySelectors) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
  }
}

async function waitForSearchPageReady(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
  await waitForBlockingOverlaysToClear(page);
  await page.waitForTimeout(1200);
}

async function openAldiSearch(page) {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  await waitForSearchPageReady(page);
  await page.locator('#search-bar-input').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
}

async function getWorkingSearchInput(page) {
  const selectorCandidates = [
    '#search-bar-input',
    'input#search-bar-input',
    'input[type="search"]#search-bar-input',
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'form input[type="search"]',
    'form input'
  ];

  for (const selector of selectorCandidates) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    const tagName = await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
    if (tagName !== 'input') continue;

    const inputType = await locator.getAttribute('type').catch(() => null);
    if (inputType && ['hidden', 'submit', 'button'].includes(String(inputType).toLowerCase())) continue;

    const box = await locator.boundingBox().catch(() => null);
    if (box && box.width < 40) continue;

    return { locator, selector };
  }

  return null;
}

async function clearAndFillSearchInput(input, term) {
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.evaluate((node) => node.focus()).catch(() => {});
  await input.focus();

  try {
    await input.fill('');
    await input.press('Control+A').catch(() => {});
    await input.press('Meta+A').catch(() => {});
    await input.press('Delete').catch(() => {});
    await input.fill(term);
  } catch (error) {
    await input.evaluate((node, value) => {
      node.value = '';
      node.focus();
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, term);
  }
}

async function submitSearch(page, input) {
  await waitForBlockingOverlaysToClear(page);
  await input.press('Enter').catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await waitForBlockingOverlaysToClear(page);
  await page.waitForTimeout(1800);
}

async function fillSearch(page, term) {
  const searchInput = await getWorkingSearchInput(page);

  if (!searchInput) {
    throw new Error('Could not find a visible search input on the Aldi search page');
  }

  console.log(`   search input selector: ${searchInput.selector}`);

  await clearAndFillSearchInput(searchInput.locator, term);
  await submitSearch(page, searchInput.locator);

  const currentValue = await searchInput.locator.inputValue().catch(() => '');
  if (normalizeText(currentValue) !== normalizeText(term)) {
    await clearAndFillSearchInput(searchInput.locator, term);
    await submitSearch(page, searchInput.locator);
  }
}

async function waitForSearchResults(page) {
  const selectors = [
    'button[aria-label^="Add "]',
    '[data-testid*="item-card"]',
    '[data-testid*="product-card"]',
    '[data-testid*="product-tile"]',
    '[data-testid*="item-tile"]',
    'div:has(button[aria-label^="Add "])',
    'article',
    'li article'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) return;
  }

  await page.waitForTimeout(1200);
}

async function findResultCards(page) {
  const selectors = [
    'div:has(button[aria-label^="Add "])',
    '[data-testid*="item-card"]',
    '[data-testid*="product-card"]',
    '[data-testid*="product-tile"]',
    '[data-testid*="item-tile"]',
    'article',
    'section article',
    'li article',
    'li'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return locator;
    }
  }

  return page.locator('article');
}

async function getCardTitle(card) {
  const addAria = await card.locator('button[aria-label^="Add "]').first().getAttribute('aria-label').catch(() => null);
  const ariaTitle = extractProductNameFromAddAriaLabel(addAria);
  if (ariaTitle) return ariaTitle;

  const preferredLocators = [
    card.locator('h2, h3, h4').first(),
    card.locator('[data-testid*="item-name"]').first(),
    card.locator('[data-testid*="product-name"]').first(),
    card.locator('div.e-1gh06cz').first()
  ];

  for (const locator of preferredLocators) {
    const text = await locator.innerText().catch(() => '');
    if (text && text.trim()) return text.trim();
  }

  const fullText = await card.innerText().catch(() => '');
  return getFirstUsefulLine(fullText);
}

async function cardHasVisibleAddButton(card) {
  const candidates = [
    card.locator('button[aria-label^="Add "]').first(),
    card.locator('button:has-text("Add")').first(),
    card.locator('[role="button"]:has-text("Add")').first(),
    card.locator('button:has-text("Add to cart")').first(),
    card.locator('[role="button"]:has-text("Add to cart")').first()
  ];

  for (const addButton of candidates) {
    const visible = await addButton.isVisible().catch(() => false);
    if (visible) {
      return { visible: true, addButton };
    }
  }

  return { visible: false, addButton: candidates[0] };
}

function cardLooksAlreadyInCart(cardText) {
  const text = normalizeText(cardText);
  return (
    text.includes('in cart') ||
    text.includes('added') ||
    text.includes('quantity') ||
    text.includes('qty') ||
    text.includes('increase amount') ||
    text.includes('decrease amount')
  );
}

async function extractBestCard(page, item) {
  await waitForSearchResults(page);

  const cards = await findResultCards(page);
  const count = Math.min(await cards.count().catch(() => 0), SEARCH_RESULT_LIMIT);
  const ranked = [];

  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const text = await card.innerText().catch(() => '');
    if (!text) continue;

    const title = await getCardTitle(card);
    if (!title) continue;

    const { visible: hasAddButton, addButton } = await cardHasVisibleAddButton(card);
    const score = scoreCandidateText(text, item);
    const excluded = textContainsExcludedTerm(text, item);
    const alreadyInCart = cardLooksAlreadyInCart(text) && !hasAddButton;

    ranked.push({
      card,
      addButton,
      title,
      text,
      score,
      excluded,
      hasAddButton,
      alreadyInCart
    });
  }

  ranked.sort((a, b) => b.score - a.score);

  if (ranked.length) {
    console.log('   top candidates:');
    ranked.slice(0, 3).forEach((candidate, index) => {
      console.log(
        `   ${index + 1}. score=${candidate.score} add=${candidate.hasAddButton} inCart=${candidate.alreadyInCart} excluded=${candidate.excluded} :: ${candidate.title}`
      );
    });
  }

  return ranked[0] || null;
}

async function pageShowsNoResults(page) {
  const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
  return bodyText.includes('no results') || bodyText.includes('no items found');
}

async function addBestMatchToCart(page, item) {
  const searchTerms = buildSearchTerms(item);

  for (const term of searchTerms) {
    console.log(`   trying search term: ${term}`);

    await openAldiSearch(page);
    await fillSearch(page, term);

    if (await pageShowsNoResults(page)) {
      console.log('   search page says no results');
      continue;
    }

    const best = await extractBestCard(page, item);

    if (!best) {
      console.log('   no result cards extracted');
      continue;
    }

    if (best.score < MIN_ACCEPTABLE_SCORE) {
      console.log(`   best score ${best.score} below threshold ${MIN_ACCEPTABLE_SCORE}`);
      continue;
    }

    if (best.excluded) {
      console.log('   best candidate contained excluded terms, trying next search term');
      continue;
    }

    if (best.alreadyInCart) {
      return {
        status: 'already_in_cart',
        searchTerm: term,
        matchedTitle: best.title
      };
    }

    if (!best.hasAddButton) {
      console.log('   best candidate did not expose an Add button');
      continue;
    }

    try {
      await best.card.scrollIntoViewIfNeeded().catch(() => {});
      await best.addButton.click({ timeout: 5000 });
      await page.waitForTimeout(1800);

      return {
        status: 'added',
        searchTerm: term,
        matchedTitle: best.title
      };
    } catch (error) {
      console.log(`   add click failed for ${best.title}: ${error.message}`);
    }
  }

  return {
    status: 'not_found',
    searchTerm: searchTerms[0] || item.name,
    matchedTitle: null
  };
}

function printPurchaseQueue(items) {
  console.log('\nPURCHASE QUEUE:\n');
  items.forEach((item) => {
    const aliases = item.rule?.match?.length ? item.rule.match.join(' | ') : 'none';
    const excludes = item.rule?.exclude?.length ? item.rule.exclude.join(' | ') : 'none';

    console.log(`${item.index}. ${item.name}`);
    console.log(`   stock: ${item.stock || 'unknown'}`);
    console.log(`   qty:   ${item.qty || 'unknown'}`);
    console.log(`   size:  ${item.size || 'unknown'}`);
    console.log(`   label: ${item.label}`);
    console.log(`   aliases: ${aliases}`);
    console.log(`   excludes: ${excludes}`);
  });

  console.log(`\nTotal to purchase: ${items.length}`);
}

function printSummary(results) {
  const added = results.filter((result) => result.status === 'added');
  const alreadyInCart = results.filter((result) => result.status === 'already_in_cart');
  const notFound = results.filter((result) => result.status === 'not_found');
  const errors = results.filter((result) => result.status === 'error');

  console.log('\n===== SUMMARY =====');
  console.log(`added: ${added.length}`);
  console.log(`already_in_cart: ${alreadyInCart.length}`);
  console.log(`not_found: ${notFound.length}`);
  console.log(`errors: ${errors.length}`);

  if (notFound.length) {
    console.log('\nNot found:');
    notFound.forEach((result) => {
      console.log(`- ${result.item} (search term: ${result.searchTerm})`);
    });
  }

  if (errors.length) {
    console.log('\nErrors:');
    errors.forEach((result) => {
      console.log(`- ${result.item}: ${result.error}`);
    });
  }
}

async function keepBrowserOpenUntilInterrupted(browser) {
  console.log('\nDone. Browser left open for review. Press Ctrl+C to exit.');

  const closeAndExit = async () => {
    console.log('\nClosing browser...');
    await browser.close().catch(() => {});
    process.exit(0);
  };

  process.once('SIGINT', closeAndExit);
  process.once('SIGTERM', closeAndExit);

  await new Promise(() => {});
}

async function main() {
  console.log(`Launching Instacart with saved session... (${SCRIPT_VERSION})`);

  const browser = await getChromium().launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  console.log('Opened your saved Aldi list.');

  const parsedItems = await getListItemsFromPage(page);
  const purchaseItems = buildPurchaseItems(parsedItems);

  printPurchaseQueue(purchaseItems);

  if (purchaseItems.length !== EXPECTED_LIST_COUNT) {
    console.warn(`\nWarning: parsed ${purchaseItems.length} items instead of the expected ${EXPECTED_LIST_COUNT}.`);
  }

  const results = [];

  for (let index = 0; index < purchaseItems.length; index += 1) {
    const item = purchaseItems[index];
    console.log(`\n[${index + 1}/${purchaseItems.length}] ${item.name}`);

    try {
      const result = await addBestMatchToCart(page, item);
      results.push({ item: item.name, ...result });

      console.log(`   status: ${result.status}`);
      console.log(`   search term: ${result.searchTerm}`);
      if (result.matchedTitle) {
        console.log(`   matched: ${result.matchedTitle}`);
      }
    } catch (error) {
      results.push({
        item: item.name,
        status: 'error',
        searchTerm: item.name,
        matchedTitle: null,
        error: error.message
      });

      console.log('   status: error');
      console.log(`   error: ${error.message}`);
    }
  }

  printSummary(results);
  await keepBrowserOpenUntilInterrupted(browser);
}

module.exports = {
  normalizeText,
  tokenize,
  parseItems,
  buildPurchaseItems,
  buildSearchTerms,
  scoreCandidateText,
  trimListSectionText,
  getListItemsFromPage,
  getWorkingSearchInput,
  addBestMatchToCart,
  main
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error.message);
    process.exit(1);
  });
}
