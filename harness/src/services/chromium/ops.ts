const REF_ATTRIBUTE = 'data-harness-ref'
const MAX_CHARS = 20_000
const WAIT_FOR_TIMEOUT_MS = 10_000
const WAIT_FOR_POLL_MS = 100
const MAX_REFS = 500

export type WaitFor = { selector?: string; text?: string; timeoutMs?: number }

export type PageRef = {
  ref: number
  tag: string
  role: string | null
  name: string
  value: string
  placeholder: string
  href: string
}

export type PageContent = { title: string; url: string; text: string; refs: PageRef[] }

export type NavigatedContent = PageContent & { status: number | null; error: string | null }

export type ActedContent = PageContent & { error: string | null }

// numbers this frame's refs from start on; a start past MAX_REFS only clears the old ones
const SNAPSHOT = String.raw`(start, maxChars) => {
  const SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

  for (const el of document.querySelectorAll('[${REF_ATTRIBUTE}]')) el.removeAttribute('${REF_ATTRIBUTE}')

  const refs = []
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (start + refs.length > ${MAX_REFS}) break

    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
    if (el.closest('[aria-hidden="true"], [inert]')) continue

    const ref = start + refs.length
    el.setAttribute('${REF_ATTRIBUTE}', String(ref))

    const text = el.tagName === 'SELECT' ? '' : (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    refs.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: text || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || '',
      value: typeof el.value === 'string' && el.type !== 'password' ? el.value.slice(0, 200) : '',
      placeholder: el.getAttribute('placeholder') || '',
      href: typeof el.href === 'string' ? el.href : '',
    })
  }

  return {
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, maxChars),
    refs,
  }
}`

// the page's frames in turn, one numbering across them; a frame that can't be seen gives no refs and no text
const snapshot = (maxChars: number) => `await (async () => {
  const take = async () => {
    const main = await page.mainFrame().evaluate(${JSON.stringify(`(${SNAPSHOT})(1, ${maxChars})`)})
    const texts = [main.text]
    const refs = main.refs
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue

      const shown = await frame
        .frameElement()
        .then(el =>
          el.evaluate(e => {
            const rect = e.getBoundingClientRect()
            const style = getComputedStyle(e)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !e.closest('[aria-hidden="true"], [inert]')
          })
        )
        .catch(() => false)
      const start = shown ? refs.length + 1 : ${MAX_REFS + 1}
      const part = await frame.evaluate('(' + ${JSON.stringify(SNAPSHOT)} + ')(' + start + ', ${maxChars})').catch(() => null)
      if (part === null || !shown) continue

      texts.push(part.text)
      refs.push(...part.refs)
    }
    return { title: main.title, url: main.url, text: texts.join('\\n').slice(0, ${maxChars}), refs }
  }

  try {
    return await take()
  } catch (err) {
    if (!/Execution context was destroyed/.test(err.message)) throw err
    await page.waitForLoadState('load')
    return await take()
  }
})()`

const waitForCode = (waitFor: WaitFor | undefined) => {
  if (!waitFor?.selector && !waitFor?.text) return ''

  const timeout = waitFor.timeoutMs ?? WAIT_FOR_TIMEOUT_MS
  const inAnyFrame = (locate: string) =>
    `(await Promise.all(page.frames().map(frame => ${locate}.filter({ visible: true }).count().catch(() => 0)))).some(n => n > 0)`
  const shows = [
    waitFor.selector ? inAnyFrame(`frame.locator(${JSON.stringify(waitFor.selector)})`) : 'true',
    waitFor.text ? inAnyFrame(`frame.getByText(${JSON.stringify(waitFor.text)})`) : 'true',
  ]
  return `
  const waitUntil = Date.now() + ${timeout}
  while (!(${shows[0]} && ${shows[1]})) {
    if (Date.now() > waitUntil) throw new Error('wait_for_timed_out')
    await page.waitForTimeout(${WAIT_FOR_POLL_MS})
  }
`
}

const element = (ref: number) => `
  let element = null
  for (const frame of page.frames()) {
    const found = frame.locator(${JSON.stringify(`[${REF_ATTRIBUTE}="${ref}"]`)})
    if ((await found.count().catch(() => 0)) > 0) {
      element = found
      break
    }
  }
  if (element === null) throw new Error('ref_not_found')
`

export const ops = {
  navigate(url: string, workspaceAccessPort: number | null, until?: WaitFor): string {
    if (url.startsWith('/') && workspaceAccessPort === null) {
      return `return { ...${snapshot(MAX_CHARS)}, status: null, error: 'workspace_not_running' }`
    }

    const target = url.startsWith('/') ? `http://127.0.0.1:${workspaceAccessPort}${url}` : url

    return `
      let status = null
      let error = null
      try {
        const response = await page.goto(${JSON.stringify(target)}, { waitUntil: 'load' })
        status = response ? response.status() : null
      } catch (err) {
        error = err.message.split('\\n')[0]
      }
      if (error === null) {
        try {
          ${waitForCode(until)}
        } catch {
          error = 'waitFor timed out'
        }
      }
      return { ...${snapshot(MAX_CHARS)}, status, error }
    `
  },

  read(maxChars = MAX_CHARS, waitFor?: WaitFor): string {
    return `
      ${waitForCode(waitFor)}
      return ${snapshot(maxChars)}
    `
  },

  click(ref: number, waitFor?: WaitFor): string {
    return `
      ${element(ref)}
      await element.click()
      await page.waitForLoadState('load')
      let error = null
      try {
        ${waitForCode(waitFor)}
      } catch {
        error = 'waitFor timed out'
      }
      return { ...${snapshot(MAX_CHARS)}, error }
    `
  },

  // blur fires the field's change and blur handlers now, not at the next action; an open suggestion list keeps focus so it stays to pick from
  type(ref: number, text: string, submit: boolean, waitFor?: WaitFor): string {
    return `
      ${element(ref)}
      if ((await element.evaluate(el => el.tagName)) === 'SELECT') {
        await element.selectOption(${JSON.stringify(text)})
      } else {
        await element.fill(${JSON.stringify(text)})
      }
      if (${submit}) {
        await element.press('Enter')
        await page.waitForLoadState('load')
      } else if ((await element.getAttribute('aria-expanded')) !== 'true') {
        await element.blur()
      }
      let error = null
      try {
        ${waitForCode(waitFor)}
      } catch {
        error = 'waitFor timed out'
      }
      return { ...${snapshot(MAX_CHARS)}, error }
    `
  },

  screenshot(fullPage: boolean, waitFor?: WaitFor): string {
    return `
      ${waitForCode(waitFor)}
      return { png: (await page.screenshot({ fullPage: ${fullPage}, type: 'png' })).toString('base64') }
    `
  },

  arbitrary(code: string): string {
    return code
  },
}
