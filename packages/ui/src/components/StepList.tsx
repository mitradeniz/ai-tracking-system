import { useI18n, type Key } from "../i18n.ts";
import type { RefusedStep } from "../model.ts";

/** Steps a CLI refused, each with what it does and how risky it is. */
export function StepList({ steps, compact }: { steps: RefusedStep[]; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <ul className={`problem-steps${compact ? " compact" : ""}`}>
      {steps.map((step, i) => (
        <li className="problem-step" key={`${step.tool}-${i}`}>
          <span className={`pill step-${step.risk}`}>{t(`step_risk_${step.risk}` as Key)}</span>
          <span className="grow">
            <span>{t(`step_${step.what}` as Key)}</span>
            <code className="mono step-cmd" title={step.shown}>
              {step.shown}
            </code>
            {step.folder && <span className="small muted">{t("step_outside", { folder: step.folder })}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
