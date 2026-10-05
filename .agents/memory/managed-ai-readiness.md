---
name: Managed AI readiness
description: Distinguishing stored AI integration settings from usable runtime configuration
---

Treat stored secret-existence metadata and usable AI runtime configuration as separate checks.

**Why:** The workspace reported both managed OpenAI settings as stored, while the execution environment could not use them. Re-provisioning the existing managed integration restored access, and a real provider request succeeded. Merely seeing the secret names would have missed the failure.

**How to apply:** When diagnosing immediate AI submission failures, verify runtime readiness without displaying secret values. If the managed settings are unavailable, use the managed AI provisioning flow rather than inventing keys or endpoints, then restart the service and verify an actual request. Preserve the existing provider/model unless evidence requires a change.