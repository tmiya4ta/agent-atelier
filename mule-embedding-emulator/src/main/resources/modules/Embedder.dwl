/**
 * 実ニューラルモデルを使わず、テキストから固定次元の疑似embeddingベクトルを
 * 決定論的に生成する（signed feature hashing）。EmbedderFacade.java(Java Module経由)
 * の代替。java:invoke-staticの引数バインディングでpayloadストリームが誤って
 * 渡ってしまう既知の問題を回避するため、DataWeaveのみで完結させる。
 */
%dw 2.0
import charCode, fromCharCode from dw::core::Strings

var stopWords = ["です", "ます", "でし", "まし", "すか", "しか", "てく", "くだ", "ださ", "さい", "てい", "ては", "ても", "ので", "から", "けど", "が、"]

fun isCjk(code: Number): Boolean =
    (code >= 12352 and code <= 12447) or   // ひらがな U+3040-U+309F
    (code >= 12448 and code <= 12543) or   // カタカナ U+30A0-U+30FF
    (code >= 19968 and code <= 40959) or   // CJK統合漢字 U+4E00-U+9FFF
    (code >= 13312 and code <= 19903)      // CJK拡張A U+3400-U+4DBF

fun isAsciiAlnum(code: Number): Boolean =
    (code >= 97 and code <= 122) or (code >= 48 and code <= 57)

fun toLowerCode(code: Number): Number =
    if (code >= 65 and code <= 90) code + 32 else code

// 文字コード配列 -> トークンリスト（CJKオーバーラップバイグラム + ASCII英数字ラン）
fun tokenize(text: String): Array<String> = do {
    var codes = (text splitBy "") map ((c) -> toLowerCode(charCode(c)))
    var runs = codes reduce ((code, acc={cjkBuf: [], asciiBuf: [], tokens: []}) -> do {
        var isC = isCjk(code)
        var isA = isAsciiAlnum(code)
        ---
        if (isC)
            { cjkBuf: acc.cjkBuf << code, asciiBuf: [], tokens: acc.tokens ++ flushAscii(acc.asciiBuf) }
        else if (isA)
            { cjkBuf: [], asciiBuf: acc.asciiBuf << code, tokens: acc.tokens ++ flushCjk(acc.cjkBuf) }
        else
            { cjkBuf: [], asciiBuf: [], tokens: acc.tokens ++ flushCjk(acc.cjkBuf) ++ flushAscii(acc.asciiBuf) }
    })
    ---
    runs.tokens ++ flushCjk(runs.cjkBuf) ++ flushAscii(runs.asciiBuf)
}

fun flushAscii(buf: Array<Number>): Array<String> =
    if (isEmpty(buf)) [] else [codesToStr(buf)]

fun codesToStr(codes: Array<Number>): String =
    codes map ((c) -> fromCharCode(c)) joinBy ""

fun flushCjk(buf: Array<Number>): Array<String> =
    if (isEmpty(buf)) []
    else if (sizeOf(buf) == 1)
        (if (stopWords contains codesToStr(buf)) [] else [codesToStr(buf)])
    else
        (((0 to (sizeOf(buf) - 2)) as Array) map ((i) -> codesToStr([buf[i], buf[i + 1]])))
            filter (t) -> !(stopWords contains t)

// 文字列のハッシュコード（多項式ハッシュ、Java String.hashCode相当）
fun stringHash(s: String): Number =
    (s splitBy "") reduce ((c, acc=0) -> (acc * 31 + charCode(c)) mod 2147483647)

// テキスト -> L2正規化済みdimensions次元ベクトル
fun embed(text: String, dimensions: Number): Array<Number> = do {
    var tokens = tokenize(text default "")
    var zeros = ((0 to (dimensions - 1)) as Array) map ((i) -> 0)
    var raw = tokens reduce ((token, vec=zeros) -> do {
        var h = stringHash(token)
        var index = (h mod dimensions)
        var sign = if ((h mod 2) == 0) 1 else -1
        ---
        vec map ((v, i) -> if (i == index) v + sign else v)
    })
    var normSq = sum(raw map ((v) -> v * v))
    var norm = if (normSq == 0) 1 else sqrt(normSq)
    ---
    raw map ((v) -> v / norm)
}

// 複数テキストを一括embedding
fun embedBatch(texts: Array<String>, dimensions: Number): Array<Array<Number>> =
    texts map ((t) -> embed(t, dimensions))
