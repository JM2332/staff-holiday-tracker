Add-Type -AssemblyName System.Drawing

function New-CalendarIcon($size, $path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $forest = [System.Drawing.ColorTranslator]::FromHtml("#1C3A2B")
  $chartreuse = [System.Drawing.ColorTranslator]::FromHtml("#CDDC5C")

  $g.Clear($forest)

  $s = $size / 512.0
  function Scale([double]$v) { return [float]($v * $s) }

  # calendar page (rounded rect)
  $pageX = Scale 128
  $pageY = Scale 150
  $pageW = Scale 256
  $pageH = Scale 222
  $pageRad = Scale 28
  $pagePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $pageRad * 2
  $pagePath.AddArc($pageX, $pageY, $d, $d, 180, 90)
  $pagePath.AddArc($pageX + $pageW - $d, $pageY, $d, $d, 270, 90)
  $pagePath.AddArc($pageX + $pageW - $d, $pageY + $pageH - $d, $d, $d, 0, 90)
  $pagePath.AddArc($pageX, $pageY + $pageH - $d, $d, $d, 90, 90)
  $pagePath.CloseFigure()
  $chartreuseBrush = New-Object System.Drawing.SolidBrush $chartreuse
  $g.FillPath($chartreuseBrush, $pagePath)

  # header bar (forest cutout)
  $headerH = Scale 52
  $headerBrush = New-Object System.Drawing.SolidBrush $forest
  $g.FillRectangle($headerBrush, $pageX, $pageY, $pageW, $headerH)

  # binder rings
  $ringW = Scale 20
  $ringH = Scale 46
  $ringTop = Scale 118
  $ring1X = Scale 180
  $ring2X = Scale 312
  $g.FillRectangle($chartreuseBrush, $ring1X, $ringTop, $ringW, $ringH)
  $g.FillRectangle($chartreuseBrush, $ring2X, $ringTop, $ringW, $ringH)

  # today marker
  $markSize = Scale 64
  $markX = $pageX + ($pageW - $markSize) / 2
  $markGap = Scale 40
  $markY = $pageY + $headerH + $markGap
  $markRad = Scale 10
  $markPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $md = $markRad * 2
  $markPath.AddArc($markX, $markY, $md, $md, 180, 90)
  $markPath.AddArc($markX + $markSize - $md, $markY, $md, $md, 270, 90)
  $markPath.AddArc($markX + $markSize - $md, $markY + $markSize - $md, $md, $md, 0, 90)
  $markPath.AddArc($markX, $markY + $markSize - $md, $md, $md, 90, 90)
  $markPath.CloseFigure()
  $g.FillPath($headerBrush, $markPath)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-CalendarIcon 512 "$PSScriptRoot\icon-512.png"
New-CalendarIcon 192 "$PSScriptRoot\icon-192.png"
New-CalendarIcon 180 "$PSScriptRoot\apple-touch-icon.png"

Write-Host "Icons generated."
