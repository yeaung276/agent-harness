const REF_ATTRIBUTE = 'data-harness-ref'
const MAX_CHARS = 20_000
const WAIT_FOR_TIMEOUT_MS = 10_000

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

const SNAPSHOT = String.raw`(maxChars) => {
  const SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
  const MAX_REFS = 500

  for (const el of document.querySelectorAll('[${REF_ATTRIBUTE}]')) el.removeAttribute('${REF_ATTRIBUTE}')

  const refs = []
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (refs.length >= MAX_REFS) break

    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === 'hidden') continue

    const ref = refs.length + 1
    el.setAttribute('${REF_ATTRIBUTE}', String(ref))

    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
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

const snapshot = (maxChars: number) => `await (async () => {
  const script = ${JSON.stringify(`(${SNAPSHOT})(${maxChars})`)}
  try {
    return await page.evaluate(script)
  } catch (err) {
    if (!/Execution context was destroyed/.test(err.message)) throw err
    await page.waitForLoadState('load')
    return await page.evaluate(script)
  }
})()`

const waitForCode = (waitFor: WaitFor | undefined) => {
  if (!waitFor?.selector && !waitFor?.text) return ''

  const timeout = waitFor.timeoutMs ?? WAIT_FOR_TIMEOUT_MS
  return `
  await Promise.all([
    ${waitFor.selector ? `page.locator(${JSON.stringify(waitFor.selector)}).first().waitFor({ timeout: ${timeout} })` : ''},
    ${waitFor.text ? `page.getByText(${JSON.stringify(waitFor.text)}).first().waitFor({ timeout: ${timeout} })` : ''},
  ]).catch(() => {
    throw new Error('wait_for_timed_out')
  })
`
}

const element = (ref: number) => `
  const element = page.locator(${JSON.stringify(`[${REF_ATTRIBUTE}="${ref}"]`)})
  if ((await element.count()) === 0) throw new Error('ref_not_found')
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
      ${waitForCode(waitFor)}
      ${element(ref)}
      await element.click()
      await page.waitForLoadState('load')
      return ${snapshot(MAX_CHARS)}
    `
  },

  type(ref: number, text: string, submit: boolean, waitFor?: WaitFor): string {
    return `
      ${waitForCode(waitFor)}
      ${element(ref)}
      await element.fill(${JSON.stringify(text)})
      if (${submit}) {
        await element.press('Enter')
        await page.waitForLoadState('load')
      }
      return ${snapshot(MAX_CHARS)}
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
