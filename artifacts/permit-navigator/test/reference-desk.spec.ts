import { expect, test, type Page, type Route } from '@playwright/test';

const checkedAt = '2026-09-30T12:00:00.000Z';

function prototypeSource(id: string, state: 'demo' | 'outdated' | 'unavailable') {
  return {
    id,
    topic: 'rules',
    title: `Example source ${id}`,
    version: 'prototype-1',
    revisedAt: '2026-09-29T00:00:00.000Z',
    officialReferenceUrl: 'https://www.sanjoseca.gov/business/development-services-permit-center',
    content: `Fictional example content for ${id}`,
    checkedAt,
    state,
  };
}

function record(id: string, options: { synthetic: boolean; freshness: 'demo' | 'cached' | 'outdated' }) {
  return {
    id,
    category: 'Commercial',
    status: 'Issued',
    department: 'Building',
    language: options.synthetic ? 'English' : 'Not provided',
    description: options.synthetic ? 'Fictional example record' : 'Commercial/industrial building permit metadata',
    synthetic: options.synthetic,
    sourceUrl: options.synthetic ? null : 'https://data.sanjoseca.gov/dataset/last-30-days-building-permits',
    updatedAt: checkedAt,
    sourceDate: options.synthetic ? null : '2026-09-25T12:00:00.000Z',
    sourceImportedAt: options.synthetic ? null : '2026-09-27T12:00:00.000Z',
    freshness: options.freshness,
  };
}

async function routeWorkspace(page: Page, handlers: {
  records?: (route: Route, url: URL) => Promise<void>;
  prototypes?: (route: Route) => Promise<void>;
}) {
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/workspace/conversations' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/workspace/records' && method === 'GET' && handlers.records) {
      return handlers.records(route, new URL(route.request().url()));
    }
    if (pathname === '/api/workspace/prototype-sources' && method === 'GET' && handlers.prototypes) {
      return handlers.prototypes(route);
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });
}

test('reference records show loading and empty states', async ({ page }) => {
  let releaseRecords!: () => void;
  const initialRead = new Promise<void>(resolve => { releaseRecords = resolve; });
  await routeWorkspace(page, {
    records: async (route, url) => {
      if (url.searchParams.get('mode') === 'research') {
        await initialRead;
      }
      await route.fulfill({ json: [] });
    },
    prototypes: async route => route.fulfill({ json: [] }),
  });
  await page.goto('/test/harness.html');
  const referenceDesk = page.locator('.ws-reference');
  await expect(referenceDesk.locator('.ws-ref-skeleton')).toBeVisible();
  releaseRecords();
  await expect(referenceDesk.getByText('No records found')).toBeVisible();
  await expect(referenceDesk.getByText('Reference records will appear here when available.')).toBeVisible();
});

test('public record errors can be retried and outdated and synthetic records stay distinct', async ({ page }) => {
  let recordReads = 0;
  await routeWorkspace(page, {
    records: async route => {
      recordReads++;
      if (recordReads === 1) {
        await route.fulfill({ status: 503, json: { error: 'Source cache unavailable' } });
        return;
      }
      await route.fulfill({ json: [
        record('SJ-OPEN-2026-001-CI', { synthetic: false, freshness: 'outdated' }),
        record('DEMO-D2-EXAMPLE-01', { synthetic: true, freshness: 'demo' }),
      ] });
    },
    prototypes: async route => route.fulfill({ json: [] }),
  });

  await page.goto('/test/harness.html');
  const referenceDesk = page.locator('.ws-reference');
  await expect(referenceDesk.getByText('References unavailable')).toBeVisible();
  await expect(referenceDesk.getByText(/couldn't load the source cache/i)).toBeVisible();
  await referenceDesk.getByTestId('button-retry-records').click();

  const publicRecord = referenceDesk.getByTestId('card-record-SJ-OPEN-2026-001-CI');
  await expect(publicRecord).toContainText('Import overdue');
  await expect(publicRecord.getByTestId('link-record-source-SJ-OPEN-2026-001-CI')).toHaveAttribute(
    'href',
    'https://data.sanjoseca.gov/dataset/last-30-days-building-permits',
  );
  const syntheticRecord = referenceDesk.getByTestId('card-record-DEMO-D2-EXAMPLE-01');
  await expect(syntheticRecord.getByText('Synthetic example', { exact: true })).toBeVisible();
  await expect(syntheticRecord.getByText('Fictional example record')).toBeVisible();
  await expect(syntheticRecord.getByTestId('link-record-source-DEMO-D2-EXAMPLE-01')).toHaveCount(0);
  expect(recordReads).toBe(2);
});

test('prototype source loading, retry, stale, and unavailable states remain explicitly synthetic', async ({ page }) => {
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>(resolve => { releaseFirstRead = resolve; });
  let sourceReads = 0;
  await routeWorkspace(page, {
    records: async route => route.fulfill({ json: [] }),
    prototypes: async route => {
      sourceReads++;
      if (sourceReads === 1) {
        await firstRead;
        await route.fulfill({ status: 503, json: { error: 'Prototype source check failed' } });
        return;
      }
      await route.fulfill({ json: [
        prototypeSource('demo-outdated', 'outdated'),
        prototypeSource('demo-unavailable', 'unavailable'),
      ] });
    },
  });

  await page.goto('/test/harness.html');
  await page.getByTestId('button-mode-live').click();
  const referenceDesk = page.locator('.ws-reference');
  await expect(referenceDesk.locator('.ws-ref-skeleton')).toBeVisible();
  releaseFirstRead();
  await expect(referenceDesk.getByText('Sample documents unavailable')).toBeVisible();
  await referenceDesk.getByTestId('button-retry-prototype-sources').click();

  await expect(referenceDesk.getByText('Outdated example — do not rely on it')).toBeVisible();
  await expect(referenceDesk.getByText('Example unavailable — not for use')).toBeVisible();
  await expect(referenceDesk.getByText('This fictional example is unavailable and must not be used.')).toBeVisible();
  const outdated = referenceDesk.getByTestId('card-prototype-source-demo-outdated');
  const unavailable = referenceDesk.getByTestId('card-prototype-source-demo-unavailable');
  await expect(outdated.getByText('Synthetic example')).toBeVisible();
  await expect(unavailable.getByText('Synthetic example')).toBeVisible();
  await expect(unavailable.getByText('Fictional example content for demo-unavailable')).toHaveCount(0);
  await expect(referenceDesk.getByText('Open City source page').first()).toHaveAttribute(
    'href',
    'https://www.sanjoseca.gov/business/development-services-permit-center',
  );
  expect(sourceReads).toBe(2);
});

test('asking about a sample reference sends immediately and shows the pending chat', async ({ page }) => {
  const conversationId = '22345678-1234-4234-8234-123456789abc';
  const conversation = {
    id: conversationId,
    title: 'Sample reference question',
    mode: 'live',
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  const assistantText = 'Sample data — Synthetic. Verify current planning requirements with City sources.';
  let conversations: typeof conversation[] = [];
  let messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> = [];
  let createRequests = 0;
  let sendRequests = 0;
  let createdMode = '';
  let sentContent = '';
  let releaseSend!: () => void;
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });

  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/workspace/conversations' && method === 'GET') {
      return route.fulfill({ json: conversations });
    }
    if (pathname === '/api/workspace/conversations' && method === 'POST') {
      createRequests++;
      createdMode = route.request().postDataJSON().mode;
      conversations = [conversation];
      return route.fulfill({ status: 201, json: conversation });
    }
    if (pathname === '/api/workspace/prototype-sources' && method === 'GET') {
      return route.fulfill({ json: [prototypeSource('demo-planning', 'demo')] });
    }
    if (pathname === '/api/workspace/records' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}/messages` && method === 'GET') {
      return route.fulfill({ json: messages });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}/messages` && method === 'POST') {
      sendRequests++;
      sentContent = route.request().postDataJSON().content;
      await sendGate;
      const userMessage = {
        id: 'sample-user-message',
        role: 'user' as const,
        content: sentContent,
        createdAt: checkedAt,
      };
      const assistantMessage = {
        id: 'sample-assistant-message',
        role: 'assistant' as const,
        content: assistantText,
        createdAt: checkedAt,
      };
      messages = [userMessage, assistantMessage];
      return route.fulfill({
        status: 201,
        json: {
          message: assistantMessage,
          sources: [],
          synthetic: true,
          escalation: null,
          securityStatus: 'PII-filtered · role-scoped · simulated tool gateway',
        },
      });
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });

  const expectedQuestion = 'What does the synthetic sample "Example source demo-planning" show about rules, and what should I verify with current City sources?';
  try {
    await page.goto('/test/harness.html');
    await page.getByTestId('button-mode-live').click();
    await page.getByTestId('button-ask-prototype-source-demo-planning').click();

    await expect.poll(() => createRequests).toBe(1);
    await expect.poll(() => sendRequests).toBe(1);
    expect(createdMode).toBe('live');
    expect(sentContent).toBe(expectedQuestion);
    await expect(page.getByTestId('input-workspace-question')).toHaveValue('');
    await expect(page.getByTestId('pending-workspace-question')).toContainText(expectedQuestion);
    await expect(page.getByTestId('workspace-response-loading')).toContainText('Researching');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    releaseSend();
  }

  await expect(page.getByText(assistantText)).toBeVisible();
  await expect(page.getByText(expectedQuestion)).toBeVisible();
  await expect(page.getByTestId('pending-workspace-question')).toHaveCount(0);
});

test('AI request errors are explained, the draft is preserved, and it can be retried', async ({ page }) => {
  const conversationId = '32345678-1234-4234-8234-123456789abc';
  const conversation = {
    id: conversationId,
    title: 'Starting a small business',
    mode: 'research',
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  const question = 'Where do I start with permits for a new small business?';
  const providerError = 'AI provider access was rejected. Your question was not saved; restore provider access, then retry.';
  const assistantText = 'Start by confirming the business type and location with the City.';
  let sendRequests = 0;
  let savedMessages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> = [];

  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/workspace/conversations' && method === 'GET') {
      return route.fulfill({ json: [conversation] });
    }
    if (pathname === '/api/workspace/conversations' && method === 'POST') {
      throw new Error('The existing conversation should be reused.');
    }
    if (pathname === '/api/workspace/prototype-sources' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/workspace/records' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}/messages` && method === 'GET') {
      return route.fulfill({ json: savedMessages });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}/messages` && method === 'POST') {
      sendRequests++;
      if (sendRequests === 1) {
        return route.fulfill({ status: 503, json: { error: providerError } });
      }
      if (sendRequests === 2) {
        return route.abort('failed');
      }
      const createdAt = checkedAt;
      const userMessage = { id: 'retry-user-message', role: 'user' as const, content: question, createdAt };
      const assistantMessage = { id: 'retry-assistant-message', role: 'assistant' as const, content: assistantText, createdAt };
      savedMessages = [userMessage, assistantMessage];
      return route.fulfill({
        status: 201,
        json: {
          message: assistantMessage,
          sources: [],
          synthetic: false,
          escalation: null,
          securityStatus: 'PII-filtered · role-scoped · simulated tool gateway',
        },
      });
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });

  await page.goto('/test/harness.html');
  await expect(page.getByText('A new conversation.')).toBeVisible();
  const input = page.getByTestId('input-workspace-question');
  const send = page.getByTestId('button-send-workspace-message');

  await input.fill(question);
  await send.click();
  await expect(page.getByTestId('status-workspace-error')).toContainText(providerError);
  await expect(input).toHaveValue(question);
  await expect(page.getByTestId('pending-workspace-question')).toHaveCount(0);
  expect(sendRequests).toBe(1);

  await send.click();
  await expect(page.getByTestId('status-workspace-error')).toContainText(
    "Couldn't reach the workspace. Your question remains in the composer; check your connection and retry.",
  );
  await expect(input).toHaveValue(question);
  expect(sendRequests).toBe(2);

  await send.click();
  await expect(page.getByText(assistantText)).toBeVisible();
  await expect(input).toHaveValue('');
  expect(sendRequests).toBe(3);
});

test('typing never sends, rapid Enter sends once, and a history outage cannot hide the saved answer', async ({ page }) => {
  const id = '42345678-1234-4234-8234-123456789abc';
  const question = 'What should I check before opening a food business?';
  const assistantText = 'Please confirm the kind of food business and location.';
  const conversation = { id, title: 'Food business question', mode: 'research', createdAt: checkedAt, updatedAt: checkedAt };
  let createRequests = 0;
  let sendRequests = 0;
  let completed = false;
  let releaseSend!: () => void;
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/workspace/conversations') {
      if (method === 'POST') {
        createRequests++;
        return route.fulfill({ status: 201, json: conversation });
      }
      return route.fulfill({ json: createRequests ? [conversation] : [] });
    }
    if (pathname === `/api/workspace/conversations/${id}/messages`) {
      if (method === 'POST') {
        sendRequests++;
        expect(route.request().postDataJSON()).toEqual({ content: question });
        await sendGate;
        completed = true;
        return route.fulfill({ status: 201, json: {
          message: { id: 'received-answer', role: 'assistant', content: assistantText, createdAt: checkedAt },
          sources: [], synthetic: true, escalation: null, securityStatus: 'PII-filtered',
        } });
      }
      return completed
        ? route.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } })
        : route.fulfill({ json: [] });
    }
    if (pathname === '/api/workspace/records' || pathname === '/api/workspace/prototype-sources') {
      return route.fulfill({ json: [] });
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });
  try {
    await page.goto('/test/harness.html');
    await expect(page.getByText('What are you trying to do?')).toBeVisible();
    const input = page.getByTestId('input-workspace-question');
    await input.fill(question);
    await input.press('Shift+Enter');
    expect(createRequests).toBe(0);
    expect(sendRequests).toBe(0);
    await input.fill(question);
    await input.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await expect.poll(() => sendRequests).toBe(1);
    expect(createRequests).toBe(1);
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue(question);
    await expect(page.getByTestId('button-mode-live')).toBeDisabled();
    await expect(page.getByTestId('button-new-conversation')).toBeDisabled();
  } finally {
    releaseSend();
  }
  await expect(page.getByText(assistantText)).toBeVisible();
  await expect(page.getByTestId('input-workspace-question')).toBeEnabled();
  await expect(page.getByTestId('input-workspace-question')).toHaveValue('');
  await expect(page.getByTestId('status-workspace-error')).toHaveCount(0);
  expect(sendRequests).toBe(1);
});

test('users can cancel conversation deletion or delete the open conversation', async ({ page }) => {
  const conversationId = '12345678-1234-4234-8234-123456789abc';
  const conversation = {
    id: conversationId,
    title: 'Planning a storefront',
    mode: 'research',
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  let deleted = false;
  let deleteRequests = 0;

  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/workspace/conversations' && method === 'GET') {
      return route.fulfill({ json: deleted ? [] : [conversation] });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}/messages` && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === `/api/workspace/conversations/${conversationId}` && method === 'DELETE') {
      deleteRequests++;
      deleted = true;
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/api/workspace/records' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/workspace/prototype-sources' && method === 'GET') {
      return route.fulfill({ json: [] });
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  });

  await page.goto('/test/harness.html');
  await expect(page.getByText('A new conversation.')).toBeVisible();
  const deleteButton = page.getByTestId(`button-delete-conversation-${conversationId}`);
  const confirmationText = 'Are you sure you want to delete this conversation? This action cannot be undone.';

  page.once('dialog', async dialog => {
    expect(dialog.message()).toBe(confirmationText);
    await dialog.dismiss();
  });
  await deleteButton.click();
  await expect(deleteButton).toBeVisible();
  expect(deleteRequests).toBe(0);

  page.once('dialog', async dialog => {
    expect(dialog.message()).toBe(confirmationText);
    await dialog.accept();
  });
  await deleteButton.click();

  await expect(page.getByTestId(`button-delete-conversation-${conversationId}`)).toHaveCount(0);
  await expect(page.getByText('What are you trying to do?')).toBeVisible();
  await expect(page.getByTestId('status-workspace-error')).toContainText('Conversation deleted.');
  expect(deleteRequests).toBe(1);
});