/// JSON Web Tokens in headers, cookies and query values: decoded on the
/// phone (header and claims, readable times) without checking the signature.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import 'strings.dart';
import 'theme.dart';
import 'widgets.dart';

class DecodedJwt {
  const DecodedJwt(this.header, this.claims, this.token);

  final Map<String, Object?> header;
  final Map<String, Object?> claims;

  /// The token without a `Bearer ` prefix.
  final String token;

  DateTime? time(String claim) => jwtTime(claims[claim]);

  DateTime? get expires => time('exp');
}

/// The token in [value] (`Bearer eyJ…` or a bare `eyJ….….…`), or null.
DecodedJwt? decodeJwt(String value) {
  var v = value.trim();
  if (v.length > 7 && v.substring(0, 7).toLowerCase() == 'bearer ') v = v.substring(7).trim();
  if (!v.startsWith('eyJ') || v.length > 16384) return null;
  final parts = v.split('.');
  if (parts.length != 3) return null;
  Map<String, Object?>? part(String s) {
    final d = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(s))));
    return d is Map<String, Object?> ? d : null;
  }

  try {
    final header = part(parts[0]);
    final claims = part(parts[1]);
    if (header == null || claims == null) return null;
    return DecodedJwt(header, claims, v);
  } catch (_) {
    return null;
  }
}

/// A NumericDate claim (seconds) as a time, or null when it is not a
/// number or outside what [DateTime] holds (a token can carry anything).
DateTime? jwtTime(Object? seconds) {
  if (seconds is! num || !seconds.isFinite) return null;
  final ms = seconds * 1000;
  if (ms.abs() > 8.64e15) return null;
  return DateTime.fromMillisecondsSinceEpoch(ms.round());
}

/// JSON that never throws: `1e400` decodes to infinity, which JSON cannot
/// encode; such values are written as text.
const JsonEncoder _json = JsonEncoder(_asText);
const JsonEncoder _jsonPretty = JsonEncoder.withIndent('  ', _asText);

Object? _asText(Object? v) => '$v';

const Set<String> _timeClaims = <String>{'exp', 'iat', 'nbf', 'auth_time'};

String _date(DateTime t) {
  String two(int v) => v.toString().padLeft(2, '0');
  return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
}

Future<void> showJwtSheet(BuildContext context, DecodedJwt jwt) {
  FocusManager.instance.primaryFocus?.unfocus();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: DurbunColors.of(context).bgPanel,
    builder: (routeContext) => DurbunTheme.wrap(routeContext, _JwtSheet(jwt: jwt)),
  );
}

class _JwtSheet extends StatelessWidget {
  const _JwtSheet({required this.jwt});

  final DecodedJwt jwt;

  @override
  Widget build(BuildContext context) {
    final c = DurbunColors.of(context);
    final t = InspectorStrings.of(context);
    final now = DateTime.now();
    final exp = jwt.expires;
    final expired = exp != null && exp.isBefore(now);
    String value(String key, Object? v) {
      final at = _timeClaims.contains(key) ? jwtTime(v) : null;
      if (at != null) {
        final span = t.spanShort(at.difference(now));
        return '${_date(at)}\n${(v! as num).round()} · ${at.isAfter(now) ? t.inSpan(span) : t.spanAgo(span)}';
      }
      return v is String ? v : _json.convert(v);
    }

    List<(String, String, Color?)> rows(Map<String, Object?> m) => <(String, String, Color?)>[
          for (final e in m.entries) (e.key, value(e.key, e.value), e.key == 'exp' && expired ? c.danger : null),
        ];
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
      child: SelectionArea(
        child: ListView(
          shrinkWrap: true,
          padding: EdgeInsets.fromLTRB(16, 0, 16, 20 + MediaQuery.paddingOf(context).bottom),
          children: <Widget>[
            Row(
              children: <Widget>[
                Text('JWT', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.3, color: c.text)),
                const SizedBox(width: 10),
                if (exp != null)
                  Flexible(
                    child: StatusPill(
                      text: expired ? t.expiredAgo(t.spanShort(now.difference(exp))) : t.expiresIn(t.spanShort(exp.difference(now))),
                      color: expired ? c.danger : c.success,
                      width: null,
                    ),
                  ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () => copyText(context, _jsonPretty.convert(<String, Object?>{'header': jwt.header, 'claims': jwt.claims})),
                  icon: Icon(Icons.copy_rounded, size: 15, color: c.textMuted),
                  label: Text(t.copyJson, style: TextStyle(color: c.textMuted, fontSize: 12.5)),
                ),
              ],
            ),
            Text(t.jwtNotVerified, style: TextStyle(fontSize: 11.5, color: c.textMeta)),
            SectionTitle(t.jwtClaims),
            KeyValueTable(rows: rows(jwt.claims)),
            SectionTitle(t.jwtHeader),
            KeyValueTable(rows: rows(jwt.header)),
          ],
        ),
      ),
    );
  }
}
