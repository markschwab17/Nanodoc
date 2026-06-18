import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { buildCitedMarkdown, parseCitationMarkers, type CiteRef } from './citationMarkup'

interface AnswerContentProps {
  answer: string
  citations?: CiteRef[]
  displayPage: (page0: number) => number
  onCiteClick: (ref: CiteRef) => void
}

/**
 * Render an assistant answer as Markdown (bold values, bullets, tables) with the
 * [Page X: "quote"] citation markers turned into inline clickable [p.N] pills.
 * If `citations` is omitted/empty (e.g. a message restored from a saved PDF), the
 * refs are derived directly from the markers in the text.
 */
export function AnswerContent({ answer, citations, displayPage, onCiteClick }: AnswerContentProps) {
  const refsSource = citations && citations.length > 0 ? citations : parseCitationMarkers(answer)
  const { markdown, refs } = buildCitedMarkdown(answer, refsSource, displayPage)

  const components: Components = {
    // Citation pills + sanitized links share the anchor renderer.
    a: ({ href, children }) => {
      if (href?.startsWith('cite:')) {
        const idx = parseInt(href.slice('cite:'.length), 10)
        const ref = refs[idx]
        return (
          <button
            type="button"
            title={ref?.quote ? `"${ref.quote}"` : undefined}
            onClick={(e) => {
              e.preventDefault()
              if (ref) onCiteClick(ref)
            }}
            className="inline-flex items-center align-baseline rounded bg-primary/10 px-1.5 py-0 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer mx-0.5"
          >
            {children}
          </button>
        )
      }
      // External links: only allow http(s); open in a new tab.
      const safe = href && /^https?:\/\//i.test(href) ? href : undefined
      return safe ? (
        <a href={safe} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )
    },
    p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    h1: ({ children }) => <h3 className="font-semibold mt-2 mb-1">{children}</h3>,
    h2: ({ children }) => <h3 className="font-semibold mt-2 mb-1">{children}</h3>,
    h3: ({ children }) => <h4 className="font-semibold mt-2 mb-1">{children}</h4>,
    table: ({ children }) => (
      <div className="overflow-x-auto my-2">
        <table className="w-full text-xs border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border px-2 py-1 text-left bg-muted/50 font-medium">{children}</th>,
    td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
    code: ({ children }) => (
      <code className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono">{children}</code>
    ),
    img: () => null, // never render LLM-emitted images (exfiltration guard)
  }

  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
