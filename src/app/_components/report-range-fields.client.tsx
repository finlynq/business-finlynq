"use client";

import { useState } from "react";
import type { ReportDimensions, ReportSelection } from "@/modules/reporting/tenant-reporting";
import styles from "./report-controls.module.css";

export function ReportRangeFields({ periods, selection }: {
  periods: ReportDimensions["entities"][number]["periods"];
  selection: ReportSelection;
}) {
  const [basis, setBasis] = useState(selection.basis);
  return <>
    <label><span>Range basis</span><select name="basis" value={basis} onChange={(event) => setBasis(event.target.value as ReportSelection["basis"])}>
      <option value="period">Fiscal periods</option><option value="date">Exact dates</option>
    </select></label>
    <label className={styles.rangeField} hidden={basis !== "period"}><span>From period</span><select name="fromPeriod" defaultValue={selection.fromPeriodId ?? ""}>
      <option value="">No period</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
    </select></label>
    <label className={styles.rangeField} hidden={basis !== "period"}><span>To period</span><select name="toPeriod" defaultValue={selection.toPeriodId ?? ""}>
      <option value="">No period</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
    </select></label>
    <label className={styles.rangeField} hidden={basis !== "date"}><span>From date</span><input name="from" type="date" defaultValue={selection.fromDate} /></label>
    <label className={styles.rangeField} hidden={basis !== "date"}><span>To date</span><input name="to" type="date" defaultValue={selection.toDate} /></label>
  </>;
}
