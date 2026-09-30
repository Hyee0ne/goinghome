// 사진에서 동물만 떼어 투명 배경 PNG로 저장한다 (macOS 내장 Apple Vision, 사진 앱의 '피사체 들어올리기'와 같은 기능).
// AI 이미지 편집 없이 무료로, 원본 픽셀을 그대로 지킨다.
//
//   swift scripts/cutout.swift <사진> <out.png>
//
// 피사체가 여럿이면(사람 손, 소품 등) 가장 큰 것 하나만 남긴다. 실패하면 0이 아닌 코드로 끝난다.
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("사용법: swift cutout.swift <사진> <out.png>\n".data(using: .utf8)!)
  exit(2)
}
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
else {
  FileHandle.standardError.write("사진을 열 수 없어요\n".data(using: .utf8)!)
  exit(1)
}
// 휴대폰 사진의 회전 정보(EXIF)를 반영해 똑바로 세운다
let orientation = CGImagePropertyOrientation(rawValue: (props[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
let image = CIImage(contentsOf: input)!.oriented(orientation)

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: image)
do {
  try handler.perform([request])
} catch {
  FileHandle.standardError.write("피사체를 찾지 못했어요: \(error)\n".data(using: .utf8)!)
  exit(1)
}
guard let result = request.results?.first, !result.allInstances.isEmpty else {
  FileHandle.standardError.write("피사체를 찾지 못했어요\n".data(using: .utf8)!)
  exit(1)
}

// 가장 큰 피사체 하나 (마스크 픽셀 수로 비교)
func area(_ instance: Int) -> Int {
  guard let mask = try? result.generateScaledMaskForImage(forInstances: [instance], from: handler) else { return 0 }
  CVPixelBufferLockBaseAddress(mask, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  let w = CVPixelBufferGetWidth(mask), h = CVPixelBufferGetHeight(mask), stride = CVPixelBufferGetBytesPerRow(mask)
  let base = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: Float32.self)
  var n = 0
  for y in Swift.stride(from: 0, to: h, by: 4) {
    for x in Swift.stride(from: 0, to: w, by: 4) where base[y * stride / 4 + x] > 0.5 { n += 1 }
  }
  return n
}
let biggest = result.allInstances.max(by: { area($0) < area($1) })!
print("피사체 \(result.allInstances.count)개 중 가장 큰 것을 씁니다")

let mask = try! result.generateScaledMaskForImage(forInstances: [biggest], from: handler)
let blend = CIFilter.blendWithMask()
blend.inputImage = image
blend.backgroundImage = CIImage.empty()
blend.maskImage = CIImage(cvPixelBuffer: mask)
let ctx = CIContext()
let cg = ctx.createCGImage(blend.outputImage!, from: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)!
let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, cg, nil)
guard CGImageDestinationFinalize(dest) else {
  FileHandle.standardError.write("저장하지 못했어요\n".data(using: .utf8)!)
  exit(1)
}
print("\(cg.width) \(cg.height)")
