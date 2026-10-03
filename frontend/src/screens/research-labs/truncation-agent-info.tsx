/**
 * What the Truncation Agent does, for a reader who has never met it. Written in ASD-STE100
 * Simplified Technical English: short sentences, one idea each, active voice. The rules repeat
 * the backend's `labs/truncation.py`; change both together.
 */

import { Flowchart, InfoButton, InfoSection } from '@/ui/info'

const EXAMPLES: [string, string][] = [
  ['USA · Delay 1 · TOP3000', '0.08'],
  ['USA · Delay 1 · TOP1000', '0.06'],
  ['USA · Delay 1 · TOP200', '0.05'],
  ['USA · Delay 0 · TOP3000', '0.05'],
  ['JPN · Delay 1 · TOP1600', '0.06'],
  ['GLB · Delay 1 · TOP3000', '0.05'],
]

export function TruncationAgentInfo() {
  return (
    <InfoButton
      title="Truncation Agent"
      description="It sets Truncation for each market. It uses fixed rules."
    >
      <InfoSection title="What Truncation does">
        <p>Truncation sets the maximum weight of one stock in the Alpha.</p>
        <p>
          For example, Truncation <span className="num text-ink">0.08</span> lets one stock hold a
          maximum of 8% of the Alpha.
        </p>
        <p>
          BRAIN fails the Weight test if one stock has too much weight. For consultants, the limit
          is 8% in USA and 10% in other regions.
        </p>
      </InfoSection>

      <InfoSection title="Why one value is not always correct">
        <p>
          A Universe with many stocks can use a higher Truncation. The Alpha still holds many
          stocks.
        </p>
        <p>
          A Universe with few stocks needs a lower Truncation. If not, a small number of stocks can
          control the Alpha.
        </p>
        <p>
          A Region with many countries needs a lower Truncation. Then a problem in one country
          cannot control the Alpha.
        </p>
        <p>
          An Alpha at Delay 0 trades more. A lower Truncation decreases the risk from one stock.
        </p>
      </InfoSection>

      <InfoSection title="How the agent sets Truncation">
        <Flowchart
          label="How the Truncation Agent sets Truncation"
          nodes={[
            { kind: 'step', text: 'Read the market: Region, Delay and Universe.' },
            {
              kind: 'decision',
              question: 'How many stocks does the Universe have?',
              branches: [
                { answer: '2,000 or more, or MINVOL', result: '0.08' },
                { answer: '1,000 to 1,999', result: '0.06' },
                { answer: 'Less than 1,000', result: '0.05' },
              ],
            },
            {
              kind: 'decision',
              question: 'Is the Region GLB, EUR, ASI, AMR or All Regions? Or is the Delay 0?',
              branches: [
                { answer: 'Yes', result: 'Use 0.05 or less' },
                { answer: 'No', result: 'Keep the value' },
              ],
            },
            { kind: 'step', text: 'Make sure that the value is not more than 0.08.' },
            { kind: 'step', text: 'Use this Truncation for all simulations in this market.' },
          ]}
        />
      </InfoSection>

      <InfoSection title="Examples">
        <table className="w-full text-body">
          <tbody>
            {EXAMPLES.map(([market, value]) => (
              <tr key={market} className="border-b border-hairline-subtle last:border-b-0">
                <td className="py-1.5 text-ink-muted">{market}</td>
                <td className="num py-1.5 text-right text-ink">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </InfoSection>

      <InfoSection title="The Alpha you start from">
        <p>You can start a sweep from one of your Alphas.</p>
        <p>
          The sweep then has one simulation with all the settings of that Alpha. A star shows this
          simulation in the results.
        </p>
        <p>
          The agent does not change the Truncation of this simulation. It keeps the Truncation of
          your Alpha.
        </p>
        <p>Thus you can compare each market with your Alpha as it is now.</p>
        <p>If you start from an expression, the sweep has no starred simulation.</p>
      </InfoSection>

      <InfoSection title="When to use Single Value">
        <p>Use Single Value to give all markets the same Truncation.</p>
        <p>Use Single Value to compare markets with no other change.</p>
      </InfoSection>

      <InfoSection title="The rules do not change">
        <p>The agent does not learn and does not guess.</p>
        <p>The same market always gets the same Truncation.</p>
      </InfoSection>
    </InfoButton>
  )
}
