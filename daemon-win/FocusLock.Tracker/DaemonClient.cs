using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace FocusLock.Tracker;

/// <summary>
/// Newline-delimited-JSON client for <c>\\.\pipe\focuslock</c>.
///
/// <para>
/// One instance owns one <see cref="NamedPipeClientStream"/>. When the
/// pipe drops (daemon restart, service stop), the caller <see cref="Close"/>s
/// this instance and constructs a new one — mirrors the mac tracker's
/// per-connection <c>IPCClient</c> pattern.
/// </para>
///
/// <para>
/// Not thread-safe. The tracker's sample loop is single-threaded, so we
/// don't pay a mutex cost.
/// </para>
/// </summary>
internal sealed class DaemonClient : IDisposable
{
    internal const string PipeName = "focuslock";

    /// <summary>Wire encoding — daemon's <c>IpcPipeService</c> uses camelCase
    /// property naming with case-insensitive read. Payload types (usage.*)
    /// annotate their own <c>[JsonPropertyName]</c> for snake_case per the
    /// docs/usage-analytics-schema.md §2.3 contract.</summary>
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy   = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private NamedPipeClientStream? _pipe;
    private StreamReader?          _reader;
    private StreamWriter?          _writer;

    /// <summary>Blocks until the pipe connects or throws.</summary>
    internal void Connect(int connectTimeoutMs)
    {
        var pipe = new NamedPipeClientStream(
            serverName: ".",
            pipeName:   PipeName,
            direction:  PipeDirection.InOut,
            options:    PipeOptions.Asynchronous);
        pipe.Connect(connectTimeoutMs);

        _pipe   = pipe;
        _reader = new StreamReader(pipe, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), leaveOpen: true);
        _writer = new StreamWriter(pipe, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)) { AutoFlush = true, NewLine = "\n" };
    }

    /// <summary>
    /// Send a typed request. Returns the response's <c>payload</c> JSON
    /// element (cloned so it outlives the temporary <see cref="JsonDocument"/>),
    /// or null when the response carries no payload (e.g. <c>{"type":"ok"}</c>).
    /// Throws on transport / parse failure — caller reconnects.
    /// </summary>
    internal JsonElement? Request(string type, object? payload = null)
    {
        AssertConnected();
        var reqJson = JsonSerializer.Serialize(new { type, payload }, JsonOpts);
        _writer!.WriteLine(reqJson);

        var line = _reader!.ReadLine()
            ?? throw new IOException("daemon closed pipe mid-response");

        using var doc = JsonDocument.Parse(line);
        if (doc.RootElement.TryGetProperty("type", out var t)
            && t.ValueKind == JsonValueKind.String
            && t.GetString() == "error")
        {
            var msg = doc.RootElement.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                ? m.GetString() : null;
            throw new InvalidOperationException($"daemon returned error: {msg ?? "(no message)"}");
        }
        if (!doc.RootElement.TryGetProperty("payload", out var pl))
            return null;
        return pl.Clone();
    }

    /// <summary>
    /// Same as <see cref="Request"/> but discards the response payload.
    /// The daemon always writes one response line per request; if we don't
    /// consume it, the NEXT <see cref="Request"/> reads a stale line — so
    /// this really means "drain-and-ignore", not "don't read".
    /// </summary>
    internal void SendFireAndForget(string type, object? payload = null)
    {
        AssertConnected();
        var reqJson = JsonSerializer.Serialize(new { type, payload }, JsonOpts);
        _writer!.WriteLine(reqJson);
        _ = _reader!.ReadLine()
            ?? throw new IOException("daemon closed pipe mid-response");
    }

    internal void Close()
    {
        try { _writer?.Dispose(); } catch { }
        try { _reader?.Dispose(); } catch { }
        try { _pipe?.Dispose();   } catch { }
        _writer = null;
        _reader = null;
        _pipe   = null;
    }

    public void Dispose() => Close();

    private void AssertConnected()
    {
        if (_pipe is not { IsConnected: true } || _reader is null || _writer is null)
            throw new InvalidOperationException("DaemonClient not connected");
    }
}
