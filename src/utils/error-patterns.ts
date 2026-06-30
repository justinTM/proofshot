/**
 * Language-agnostic error detection patterns for server log analysis.
 *
 * Each entry covers a language/runtime ecosystem. To add support for a new
 * language, append a new object to the PATTERNS array below.
 *
 * Patterns are tested against individual lines of server output. Each regex
 * keeps its own flags — some are case-sensitive on purpose to avoid matching
 * normal log lines like "0 errors found".
 */

interface LanguagePatterns {
  /** Human-readable language/runtime name */
  name: string;
  /** Regexes that match error lines in this language's typical output */
  patterns: RegExp[];
}

/**
 * Add new languages here. Each pattern should match lines that indicate
 * an actual error, not normal informational output.
 */
const PATTERNS: LanguagePatterns[] = [
  {
    name: 'JavaScript / Node.js',
    patterns: [
      /\bError:/,                          // TypeError: x is not a function
      /\bERR[_!]/,                         // npm ERR!, ERR_MODULE_NOT_FOUND
      /\bEACCES\b|\bENOENT\b|\bEADDRINUSE\b/, // System errors
      /\bat\s+.+\(.+:\d+:\d+\)/,          // Stack trace: at fn (file.js:10:5)
      /Unhandled.+rejection/i,             // Unhandled promise rejection
    ],
  },
  {
    name: 'Python',
    patterns: [
      /Traceback \(most recent call last\)/,
      /^\s*File ".+", line \d+/,           // Stack trace line
      /\w+Error:/,                         // ValueError:, KeyError:, etc.
      /\w+Exception:/,                     // Django ImproperlyConfigured, etc.
    ],
  },
  {
    name: 'Ruby / Rails',
    patterns: [
      /\w+Error \(.+\)/,                   // ActionController::RoutingError (...)
      /from .+:\d+:in `.+'/,              // Stack trace
      /FATAL --/,                          // Rails logger FATAL level
      /Errno::\w+/,                        // Errno::ENOENT
    ],
  },
  {
    name: 'Go',
    patterns: [
      /^panic:/,                           // Go panic
      /^goroutine \d+/,                    // Goroutine stack dump
      /runtime error:/,
    ],
  },
  {
    name: 'Java / Kotlin',
    patterns: [
      /Exception in thread/,              // Exception in thread "main"
      /\w+Exception:/,                     // NullPointerException:
      /\bat\s+[\w.$]+\(.+:\d+\)/,         // at com.example.Main(Main.java:10)
      /Caused by:/,
    ],
  },
  {
    name: 'Rust',
    patterns: [
      /thread '.+' panicked at/,           // thread 'main' panicked at
      /error\[E\d+\]/,                     // Compiler error: error[E0308]
    ],
  },
  {
    name: 'PHP',
    patterns: [
      /PHP\s+(Fatal|Parse|Warning)\s+error:/i,
      /Stack trace:/,
      /thrown in .+ on line \d+/,
    ],
  },
  {
    name: 'C# / .NET',
    patterns: [
      /Unhandled exception/,
      /\w+Exception:/,
      /at .+ in .+:line \d+/,             // Stack trace
    ],
  },
  {
    name: 'Elixir / Phoenix',
    patterns: [
      /\*\* \(\w+\)/,                      // ** (EXIT), ** (RuntimeError)
      /\(exit\) an exception was raised/,
    ],
  },
  {
    name: 'Generic',
    patterns: [
      /\bFATAL\b/,                         // Common log level
      /\bCRITICAL\b/,                      // Common log level
      /\bSegmentation fault\b/,
      /\bcore dumped\b/,
      /\bout of memory\b/i,
    ],
  },
];

/**
 * Extract lines from server log output that look like errors.
 * Tests each line against all language patterns.
 */
export function extractServerErrors(log: string): string[] {
  if (!log.trim()) return [];
  const allPatterns = PATTERNS.flatMap((lp) => lp.patterns);
  return log.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/GET\s+\/favicon\.ico\s+returned\s+404/i.test(trimmed)) return false;
    return allPatterns.some((p) => p.test(trimmed));
  });
}
