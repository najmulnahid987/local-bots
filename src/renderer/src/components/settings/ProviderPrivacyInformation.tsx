import { ReactElement } from 'react'
import { ShieldCheck, Lock, ExternalLink, Cpu } from 'lucide-react'

export function ProviderPrivacyInformation(): ReactElement {
  return (
    <div className="privacy-callout-card" aria-label="Security and Privacy Details">
      <div className="privacy-callout-header">
        <div className="privacy-callout-icon" aria-hidden="true">
          <ShieldCheck size={20} className="text-accent" />
        </div>
        <div>
          <h3 className="privacy-callout-title">Security &amp; Privacy Architecture</h3>
          <p className="privacy-callout-subtitle">
            Local credential sovereignty and direct provider communication
          </p>
        </div>
      </div>

      <div className="privacy-callout-grid">
        <div className="privacy-info-block">
          <div className="privacy-block-header">
            <Lock size={16} className="text-secondary" aria-hidden="true" />
            <span className="privacy-block-title">OS-Level Vault Encryption</span>
          </div>
          <p className="privacy-block-text">
            Your API keys are encrypted at rest using your operating system&apos;s native secure
            storage (Windows DPAPI, macOS Keychain, or Linux Secret Service). Keys never touch
            application log files, plain database rows, or remote sync services.
          </p>
        </div>

        <div className="privacy-info-block">
          <div className="privacy-block-header">
            <Cpu size={16} className="text-secondary" aria-hidden="true" />
            <span className="privacy-block-title">Direct Outbound Ingestion</span>
          </div>
          <p className="privacy-block-text">
            All AI model inference traffic travels directly from this machine to official provider
            endpoints over TLS 1.3. No intermediary proxies, third-party analytics, or external
            middleware intercept your tokens.
          </p>
        </div>
      </div>

      <div className="privacy-notices-divider" />

      <div className="privacy-vendor-notices">
        <h4 className="privacy-vendor-heading">Provider-Specific Data Policies</h4>
        <p className="privacy-vendor-intro">
          Local-first storage guarantees your keys and configuration remain on this machine.
          However, external providers process prompt text to generate completions. Their data
          retention depends on your account tier and provider agreements:
        </p>

        <ul className="privacy-vendor-list">
          <li className="privacy-vendor-item">
            <strong>OpenAI:</strong> API requests adhere to your OpenAI developer account terms.
            Standard API inputs and outputs are not used for model training by default.
            <a
              href="https://openai.com/enterprise-privacy"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="OpenAI Enterprise Privacy policy (opens in new tab)"
            >
              Policy <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
          <li className="privacy-vendor-item">
            <strong>Anthropic:</strong> Claude API data is governed by Anthropic commercial terms.
            Standard API retention applies unless an eligible Zero Data Retention (ZDR) agreement is
            active.
            <a
              href="https://trust.anthropic.com"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="Anthropic Trust Center (opens in new tab)"
            >
              Trust Center <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
          <li className="privacy-vendor-item">
            <strong>Google Gemini:</strong> Data policies differ between free and paid tiers. Free
            API keys may log prompts for model improvement, whereas paid Google Cloud/Gemini API
            tiers do not train on user data.
            <a
              href="https://ai.google.dev/terms"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="Google Gemini API Terms of Service (opens in new tab)"
            >
              Terms <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
        </ul>
      </div>
    </div>
  )
}
