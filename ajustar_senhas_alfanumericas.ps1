$ErrorActionPreference = "Stop"

$source = (Resolve-Path ".\Medias_copiar_mensagens_senhas_v2.xlsm").Path
$output = Join-Path (Resolve-Path ".").Path "Medias_copiar_mensagens_senhas_v3.xlsm"
Copy-Item -LiteralPath $source -Destination $output -Force

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
    $workbook = $excel.Workbooks.Open($output, 0, $false)
    $module = $workbook.VBProject.VBComponents.Item("ModuloWhatsApp").CodeModule
    $code = $module.Lines(1, $module.CountOfLines)

    $code = $code.Replace(
        'senha = Format$(ws.Cells(linha, 5).Value, "00000")',
        'senha = UCase$(Trim$(CStr(ws.Cells(linha, 5).Value & "")))'
    )
    $code = $code.Replace(
        'senha = Format$(wsMot.Cells(linha, 5).Value, "00000")',
        'senha = UCase$(Trim$(CStr(wsMot.Cells(linha, 5).Value & "")))'
    )

    $inicio = $code.IndexOf("Private Function SenhaValidaEUnica")
    $fim = $code.IndexOf("Public Sub CopiarAcessoSelecionado")
    if ($inicio -lt 0 -or $fim -lt 0) {
        throw "Não foi possível localizar as rotinas de senha no VBA."
    }

    $novasRotinas = @'
Private Function SenhaValidaEUnica(ByVal senha As String, ByVal usados As Object) As Boolean
    senha = UCase$(Trim$(senha))
    SenhaValidaEUnica = (senha Like "[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]") _
        And Not usados.Exists(senha)
End Function

Private Function NovaSenhaUnica(ByVal usados As Object) As String
    Dim senha As String
    Dim caracteres As String
    Dim indice As Long
    Dim posicao As Long

    caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    Do
        senha = ""
        For indice = 1 To 5
            posicao = Int(Rnd() * Len(caracteres)) + 1
            senha = senha & Mid$(caracteres, posicao, 1)
        Next indice
    Loop While usados.Exists(senha)

    usados.Add senha, True
    NovaSenhaUnica = senha
End Function

'@

    $code = $code.Substring(0, $inicio) + $novasRotinas + $code.Substring($fim)
    $module.DeleteLines(1, $module.CountOfLines)
    $module.InsertLines(1, $code)

    $workbook.Worksheets.Item("Motoristas").Cells(1, 5).Value = "Senha alfanumérica"
    $workbook.Worksheets.Item("Motoristas").Columns("E").NumberFormat = "@"
    $workbook.Save()
    Write-Output $output
}
finally {
    if ($workbook) {
        $workbook.Close($true)
        [Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
    }
    $excel.Quit()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
