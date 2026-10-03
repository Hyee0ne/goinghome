// 사진 한 장을 무료로 살펴본다 (macOS 내장 Apple Vision). 공고 사진 실사화 후보를 고르는 첫 거름망.
//
//   swift scripts/animal-detect.swift <사진>
//
// JSON 한 줄을 출력한다 (좌표는 0~1, 왼쪽 위 기준):
//   width, height                사진 크기 (방향 보정 후)
//   animals: [{label, confidence, box: [x, y, w, h]}]   개·고양이 (VNRecognizeAnimalsRequest)
//   humanFaces: 사람 얼굴 수, hands: [{x, y}] 손 위치 (손이 동물 얼굴을 가리는지 보는 용도)
//   pose: {이름: {x, y, c}}      가장 큰 동물의 관절 (눈·코·귀 등, VNDetectAnimalBodyPoseRequest. macOS 14+)
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("사용법: swift animal-detect.swift <사진>\n".data(using: .utf8)!)
  exit(2)
}
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
  let cg = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write("사진을 열 수 없어요\n".data(using: .utf8)!)
  exit(1)
}
let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
let exif = (props?[kCGImagePropertyOrientation] as? UInt32).flatMap(CGImagePropertyOrientation.init) ?? .up
let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(exif)

let animals = VNRecognizeAnimalsRequest()
let faces = VNDetectFaceRectanglesRequest()
let hands = VNDetectHumanHandPoseRequest()
hands.maximumHandCount = 4
let pose = VNDetectAnimalBodyPoseRequest()
let handler = VNImageRequestHandler(cgImage: cg, orientation: exif)
do {
  try handler.perform([animals, faces, hands, pose])
} catch {
  FileHandle.standardError.write("Vision 실패: \(error)\n".data(using: .utf8)!)
  exit(1)
}

// Vision 좌표는 왼쪽 아래 기준이라 위아래를 뒤집는다
func box(_ r: CGRect) -> [Double] { [r.minX, 1 - r.maxY, r.width, r.height].map { Double($0) } }
func pt(_ p: CGPoint) -> [String: Double] { ["x": Double(p.x), "y": Double(1 - p.y)] }

var out: [String: Any] = [
  "width": rotated ? cg.height : cg.width,
  "height": rotated ? cg.width : cg.height,
  "animals": (animals.results ?? []).map { o -> [String: Any] in
    let top = o.labels.first
    return ["label": top?.identifier ?? "", "confidence": Double(top?.confidence ?? 0), "box": box(o.boundingBox)]
  },
  "humanFaces": faces.results?.count ?? 0,
  "hands": (hands.results ?? []).compactMap { h -> [String: Double]? in
    guard let w = try? h.recognizedPoint(.wrist), w.confidence > 0.3 else { return nil }
    return pt(w.location)
  },
]
// 가장 큰 동물(관절이 가장 넓게 퍼진 것)의 관절
if let best = (pose.results ?? []).max(by: { a, b in
  let span = { (o: VNAnimalBodyPoseObservation) -> CGFloat in
    let ps = ((try? o.recognizedPoints(.all)) ?? [:]).values.filter { $0.confidence > 0.3 }.map(\.location)
    guard let minX = ps.map(\.x).min(), let maxX = ps.map(\.x).max(), let minY = ps.map(\.y).min(), let maxY = ps.map(\.y).max() else { return 0 }
    return (maxX - minX) * (maxY - minY)
  }
  return span(a) < span(b)
}), let pts = try? best.recognizedPoints(.all) {
  var joints: [String: Any] = [:]
  for (name, p) in pts where p.confidence > 0.1 {
    var j = pt(p.location)
    j["c"] = Double(p.confidence)
    joints[name.rawValue.rawValue] = j
  }
  out["pose"] = joints
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
