import Foundation

/// Tiny 5-field cron evaluator: minute, hour, day-of-month, month, day-of-week.
/// Each field accepts `*`, a literal integer, `N-M` ranges, `N,M,O` lists, and
/// `*/N` steps.
///
/// Semantics for the family-controls schedule rule are intentionally simple:
/// a rule is "active right now" iff the current minute matches all five fields.
/// Cross-midnight windows (e.g. weekday 9pm–6am) must be expressed as two
/// rules — the design doc notes this trade-off.
///
/// All evaluation happens in the device's local time, matching what the parent
/// meant when they typed "9pm".
struct CronEvaluator {
    private let minute: Set<Int>
    private let hour: Set<Int>
    private let dayOfMonth: Set<Int>
    private let month: Set<Int>
    private let dayOfWeek: Set<Int>

    static func parse(_ expr: String?) -> CronEvaluator? {
        guard let expr = expr?.trimmingCharacters(in: .whitespaces), !expr.isEmpty else { return nil }
        let parts = expr.split(separator: " ").map(String.init)
        guard parts.count == 5 else { return nil }

        guard let m  = parseField(parts[0], min: 0, max: 59),
              let h  = parseField(parts[1], min: 0, max: 23),
              let d  = parseField(parts[2], min: 1, max: 31),
              let mo = parseField(parts[3], min: 1, max: 12),
              // POSIX cron treats weekday 7 as Sunday (alias of 0). Accept 0-7
              // during parse and collapse 7 → 0 afterwards so a family-pushed
              // rule like "0 9 * * 7" (Sunday 9am) matches instead of silently
              // failing — mirrors ScheduleService. See #247.
              let dw = parseField(parts[4], min: 0, max: 7) else { return nil }
        var normalizedDw = dw
        if normalizedDw.remove(7) != nil { normalizedDw.insert(0) }

        return CronEvaluator(minute: m, hour: h, dayOfMonth: d, month: mo, dayOfWeek: normalizedDw)
    }

    func matches(_ now: Date) -> Bool {
        let cal = Calendar.current
        let comps = cal.dateComponents([.minute, .hour, .day, .month, .weekday], from: now)
        guard let mi = comps.minute, let ho = comps.hour,
              let dy = comps.day, let mo = comps.month, let wd = comps.weekday else {
            return false
        }
        // Calendar.weekday: Sunday=1..Saturday=7. Normalize to Sunday=0..Sat=6.
        let dow = (wd - 1) % 7
        return minute.contains(mi)
            && hour.contains(ho)
            && dayOfMonth.contains(dy)
            && month.contains(mo)
            && dayOfWeek.contains(dow)
    }

    private static func parseField(_ field: String, min: Int, max: Int) -> Set<Int>? {
        var result = Set<Int>()
        for rawToken in field.split(separator: ",") {
            let token = rawToken.trimmingCharacters(in: .whitespaces)
            if token.isEmpty { return nil }

            var step = 1
            var body = token
            if let slash = token.firstIndex(of: "/") {
                let stepStr = token[token.index(after: slash)...]
                guard let s = Int(stepStr), s > 0 else { return nil }
                step = s
                body = String(token[..<slash])
            }

            var rangeStart: Int
            var rangeEnd: Int
            if body == "*" {
                rangeStart = min; rangeEnd = max
            } else if let dash = body.firstIndex(of: "-") {
                guard let a = Int(body[..<dash]),
                      let b = Int(body[body.index(after: dash)...]) else { return nil }
                rangeStart = a; rangeEnd = b
            } else {
                guard let v = Int(body) else { return nil }
                rangeStart = v; rangeEnd = v
            }

            if rangeStart < min || rangeEnd > max || rangeStart > rangeEnd { return nil }
            var v = rangeStart
            while v <= rangeEnd { result.insert(v); v += step }
        }
        return result
    }
}
