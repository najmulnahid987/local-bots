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
            The application sends model requests over HTTPS directly to fixed official provider
            endpoints without an application-configured proxy or AI gateway. The negotiated TLS
            version depends on the runtime and server. The selected AI provider receives submitted
            prompts and content and handles them under its applicable account terms, retention
            policy, and service tier.
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
          <li className="privacy-vendor-item">
            <strong>Groq:</strong> API requests travel directly over HTTPS to Groq LPU endpoints.
            Groq does not train on API customer prompts or responses by default under commercial API
            data terms.
            <a
              href="https://console.groq.com/docs/your-data"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="Groq Data Privacy Documentation (opens in new tab)"
            >
              Data Terms <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
          <li className="privacy-vendor-item">
            <strong>OpenRouter:</strong> Local Bots connects directly to OpenRouter over HTTPS, but{' '}
            <strong>OpenRouter acts as an intermediary router</strong> that forwards prompts to
            selected underlying inference providers under your OpenRouter account, privacy, and
            provider-routing settings (unlike direct OpenAI, Anthropic, Google, or Groq keys). ZDR
            filtering narrows endpoints where available and is not an absolute zero-retention
            guarantee across all settings.
            <a
              href="https://openrouter.ai/privacy"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="OpenRouter Privacy Policy (opens in new tab)"
            >
              Privacy Policy <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
          <li className="privacy-vendor-item">
            <strong>Perplexity:</strong> Prompts and retrieved context travel directly over HTTPS to{' '}
            <code>api.perplexity.ai</code> under your Perplexity API terms. When using Agent API
            presets or third-party model identifiers, Perplexity may route requests to third-party
            model providers. Local Bots sets <code>store: false</code> where supported, which
            disables later server response retrieval but does <strong>not</strong> guarantee zero
            data retention across Perplexity or routed model vendors.
            <a
              href="https://www.perplexity.ai/hub/legal/privacy-policy"
              target="_blank"
              rel="noreferrer noopener"
              className="privacy-external-link"
              aria-label="Perplexity Privacy Policy (opens in new tab)"
            >
              Privacy Policy <ExternalLink size={12} className="inline-icon" aria-hidden="true" />
            </a>
          </li>
        </ul>
      </div>
    </div>
  )
}
