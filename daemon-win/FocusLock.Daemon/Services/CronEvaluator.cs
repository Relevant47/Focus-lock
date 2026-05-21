namespace FocusLock.Daemon.Services;

/// <summary>
/// Tiny 5-field cron evaluator: minute, hour, day-of-month, month, day-of-week.
/// Each field accepts <c>*</c>, a literal integer, <c>N-M</c> ranges,
/// <c>N,M,O</c> lists, and <c>*/N</c> steps.
///
/// Semantics for the family-controls schedule rule are intentionally simple:
/// a rule is "active right now" iff the *current minute* matches all five
/// fields. Cross-midnight windows (e.g. weekday 9pm–6am) must be expressed
/// as two rules — the design doc notes this trade-off.
///
/// All evaluation happens in the device's *local* time, matching what the
/// parent meant when they typed "9pm".
/// </summary>
public sealed class CronEvaluator
{
    private readonly bool _valid;
    private readonly HashSet<int> _minute;
    private readonly HashSet<int> _hour;
    private readonly HashSet<int> _dayOfMonth;
    private readonly HashSet<int> _month;
    private readonly HashSet<int> _dayOfWeek;

    private CronEvaluator(bool valid,
        HashSet<int> minute, HashSet<int> hour,
        HashSet<int> dayOfMonth, HashSet<int> month, HashSet<int> dayOfWeek)
    {
        _valid = valid;
        _minute = minute;
        _hour = hour;
        _dayOfMonth = dayOfMonth;
        _month = month;
        _dayOfWeek = dayOfWeek;
    }

    public static CronEvaluator? Parse(string? expr)
    {
        if (string.IsNullOrWhiteSpace(expr)) return null;
        var parts = expr.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 5) return null;

        var minute     = ParseField(parts[0], 0, 59);
        var hour       = ParseField(parts[1], 0, 23);
        var dayOfMonth = ParseField(parts[2], 1, 31);
        var month      = ParseField(parts[3], 1, 12);
        var dayOfWeek  = ParseField(parts[4], 0, 6);  // Sunday = 0
        if (minute == null || hour == null || dayOfMonth == null
            || month == null || dayOfWeek == null) return null;

        return new CronEvaluator(true, minute, hour, dayOfMonth, month, dayOfWeek);
    }

    public bool Matches(DateTime localNow)
    {
        if (!_valid) return false;
        var dow = (int)localNow.DayOfWeek;  // .NET: Sunday=0 too
        return _minute.Contains(localNow.Minute)
            && _hour.Contains(localNow.Hour)
            && _dayOfMonth.Contains(localNow.Day)
            && _month.Contains(localNow.Month)
            && _dayOfWeek.Contains(dow);
    }

    private static HashSet<int>? ParseField(string field, int min, int max)
    {
        var result = new HashSet<int>();
        foreach (var token in field.Split(','))
        {
            var t = token.Trim();
            if (t.Length == 0) return null;

            int step = 1;
            string body = t;
            var slash = t.IndexOf('/');
            if (slash >= 0)
            {
                if (!int.TryParse(t[(slash + 1)..], out step) || step <= 0) return null;
                body = t[..slash];
            }

            int rangeStart, rangeEnd;
            if (body == "*")
            {
                rangeStart = min; rangeEnd = max;
            }
            else if (body.Contains('-'))
            {
                var dash = body.IndexOf('-');
                if (!int.TryParse(body[..dash],            out rangeStart)) return null;
                if (!int.TryParse(body[(dash + 1)..],      out rangeEnd))   return null;
            }
            else
            {
                if (!int.TryParse(body, out rangeStart)) return null;
                rangeEnd = rangeStart;
            }

            if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) return null;
            for (int v = rangeStart; v <= rangeEnd; v += step) result.Add(v);
        }
        return result;
    }
}
