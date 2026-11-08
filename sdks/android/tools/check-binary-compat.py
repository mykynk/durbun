#!/usr/bin/env python3
"""Static checks on the compiled SDK (run after a Gradle build; no Gradle needed).

1. API parity: the public classes of :durbun and :durbun-noop expose identical signatures.
2. OkHttp/Okio linkage: every okhttp3/okio member the :durbun bytecode references also exists in the
   given older OkHttp/Okio jars (default: OkHttp 3.14.9 + Okio 1.17.x from the Gradle cache), so apps that
   still ship OkHttp 3 do not hit NoSuchMethodError.
3. Consumer R8 rules: every okhttp3/okio class a module references has its own `-dontwarn` line in that
   module's consumer-rules.pro (no wildcards, so the app's own missing OkHttp classes are still reported).

Usage: python3 -I tools/check-binary-compat.py [--okhttp JAR --okio JAR]
"""
import argparse
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.expanduser("~/.gradle/caches/modules-2/files-2.1")
PUBLIC_CLASSES = [
    "dev.durbun.Durbun",
    "dev.durbun.DurbunOptions",
    "dev.durbun.DurbunOptions$Companion",
    "dev.durbun.Level",
    "dev.durbun.Level$Companion",
    "dev.durbun.DurbunAction",
    "dev.durbun.DurbunAction$Companion",
    "dev.durbun.DurbunAction$Kind",
    "dev.durbun.DurbunAction$Option",
    "dev.durbun.DurbunAction$ClickHandler",
    "dev.durbun.DurbunAction$ToggleHandler",
    "dev.durbun.DurbunAction$SelectHandler",
    "dev.durbun.DurbunInterceptor",
]


def classes_dir(module, variant):
    path = os.path.join(ROOT, module, "build", "tmp", "kotlin-classes", variant)
    if not os.path.isdir(path):
        sys.exit(f"missing {path} — build first")
    return path


def javap(args):
    return subprocess.run(["javap", *args], check=True, capture_output=True, text=True).stdout


def public_api(cp, cls):
    out = javap(["-public", "-cp", cp, cls])
    lines = [l.strip() for l in out.splitlines() if l.strip() and not l.startswith("Compiled from")]
    # Kotlin `internal` members are public in bytecode but name-mangled per module ($durbun_debug, ...), and
    # synthetic accessors (access$...) cannot be called from source: neither is API apps compile against.
    return sorted(l for l in lines if "$durbun" not in l and "access$" not in l)


def check_parity():
    real = classes_dir("durbun", "debug")
    noop = classes_dir("durbun-noop", "release")
    ok = True
    for cls in PUBLIC_CLASSES:
        a, b = public_api(real, cls), public_api(noop, cls)
        if a != b:
            ok = False
            print(f"API MISMATCH {cls}")
            for line in sorted(set(a) - set(b)):
                print(f"  only in durbun:      {line}")
            for line in sorted(set(b) - set(a)):
                print(f"  only in durbun-noop: {line}")
    print(f"API parity: {'OK' if ok else 'FAILED'} ({len(PUBLIC_CLASSES)} classes)")
    return ok


REF = re.compile(r"// (?:Method|InterfaceMethod|Field) ((?:okhttp3|okio)/[\w$/]+)\.(\"?[\w$<>-]+\"?):(\S+)")


def references(class_root):
    refs = set()
    for path in glob.glob(os.path.join(class_root, "**", "*.class"), recursive=True):
        rel = os.path.relpath(path, class_root)[:-6].replace(os.sep, ".")
        out = javap(["-c", "-p", "-cp", class_root, rel])
        for owner, name, desc in REF.findall(out):
            refs.add((owner, name.strip('"'), desc))
    return refs


def members(cp, owner, cache={}):
    """name+descriptor of every member of owner and its supertypes."""
    if owner in cache:
        return cache[owner]
    try:
        out = javap(["-s", "-p", "-cp", cp, owner.replace("/", ".")])
    except subprocess.CalledProcessError:
        cache[owner] = None
        return None
    found = set()
    supers = []
    lines = out.splitlines()
    for i, line in enumerate(lines):
        header = re.match(r".*\b(?:class|interface)\s+\S+(?:\s+extends\s+([\w.$,\s<>?]+?))?(?:\s+implements\s+([\w.$,\s<>?]+?))?\s*\{", line)
        if header and i < 3:
            for group in header.groups():
                if group:
                    supers += [s.strip().split("<")[0] for s in group.split(",") if s.strip()]
        if line.strip().startswith("descriptor:"):
            sig = lines[i - 1].strip()
            desc = line.strip().split(":", 1)[1].strip()
            m = re.search(r"([\w$<>]+)\(", sig)
            if m:
                name = m.group(1)
                if name == owner.split("/")[-1]:  # constructor (javap prints the binary class name)
                    name = "<init>"
                found.add((name, desc))
            else:
                fm = re.search(r"([\w$]+);$", sig)
                if fm:
                    found.add((fm.group(1), desc))
    for sup in supers:
        if sup.startswith(("okhttp3.", "okio.")):
            inherited = members(cp, sup.replace(".", "/"))
            if inherited:
                found |= inherited
    cache[owner] = found
    return found


def check_linkage(okhttp_jar, okio_jar):
    refs = references(classes_dir("durbun", "debug")) | references(os.path.join(ROOT, "durbun", "build", "intermediates", "javac", "debug", "compileDebugJavaWithJavac", "classes"))
    cp = os.pathsep.join([okhttp_jar, okio_jar])
    missing = []
    for owner, name, desc in sorted(refs):
        found = members(cp, owner)
        constructor_ok = name == "<init>" and found is not None and any(n == "<init>" and d == desc for n, d in found)
        if found is None or not ((name, desc) in found or constructor_ok):
            missing.append(f"{owner}.{name}:{desc}")
    print(f"OkHttp/Okio linkage against {os.path.basename(okhttp_jar)} + {os.path.basename(okio_jar)}: "
          f"{len(refs)} references, {len(missing)} missing")
    for m in missing:
        print(f"  MISSING {m}")
    return not missing


CLASS_REF = re.compile(r"(?<![\w/])L?((?:okhttp3|okio)/[\w$/]+)")


def check_consumer_rules():
    ok = True
    for module, variant in (("durbun", "debug"), ("durbun-noop", "release")):
        roots = [classes_dir(module, variant)]
        javac = os.path.join(ROOT, module, "build", "intermediates", "javac", variant)
        roots += glob.glob(os.path.join(javac, "**", "classes"), recursive=True)
        used = set()
        for root in roots:
            for path in glob.glob(os.path.join(root, "**", "*.class"), recursive=True):
                out = subprocess.run(["javap", "-v", path], check=True, capture_output=True, text=True).stdout
                used |= {c.replace("/", ".") for c in CLASS_REF.findall(out)}
        rules = open(os.path.join(ROOT, module, "consumer-rules.pro"), encoding="utf-8").read()
        listed = set(re.findall(r"^-dontwarn\s+(\S+)\s*$", rules, re.M))
        missing = sorted(used - listed)
        wildcards = sorted(l for l in listed if "*" in l and l.startswith(("okhttp3", "okio")))
        print(f"Consumer rules {module}: {len(used)} OkHttp/Okio classes, {len(missing)} without -dontwarn"
              + (f", wildcards: {wildcards}" if wildcards else ""))
        for m in missing:
            print(f"  ADD -dontwarn {m}")
        ok = ok and not missing and not wildcards
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--okhttp", default=next(iter(glob.glob(f"{CACHE}/com.squareup.okhttp3/okhttp/3.14.9/*/okhttp-3.14.9.jar")), None))
    parser.add_argument("--okio", default=next(iter(glob.glob(f"{CACHE}/com.squareup.okio/okio/1.17.*/*/okio-1.17.*.jar")), None))
    args = parser.parse_args()
    ok = check_parity()
    ok = check_consumer_rules() and ok
    if args.okhttp and args.okio:
        ok = check_linkage(args.okhttp, args.okio) and ok
    else:
        print("OkHttp 3 / Okio 1 jars not found in the Gradle cache; linkage check skipped")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
