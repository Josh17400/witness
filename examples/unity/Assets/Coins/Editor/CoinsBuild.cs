// Headless build for the coins example:
//   Unity -batchmode -quit -projectPath examples/unity -executeMethod CoinsBuild.Build -logFile -
// Creates the (empty) scene the game boots into, then builds a player for the current OS into Build/.
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class CoinsBuild
{
    private const string ScenePath = "Assets/Coins/Main.unity";

    public static void Build()
    {
        if (!File.Exists(ScenePath))
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(scene, ScenePath);
        }
        PlayerSettings.productName = "Coins";
        PlayerSettings.runInBackground = true;
        PlayerSettings.defaultScreenWidth = 320;
        PlayerSettings.defaultScreenHeight = 180;
        PlayerSettings.fullScreenMode = FullScreenMode.Windowed;

        BuildTarget target;
        string output;
        switch (Application.platform)
        {
            case RuntimePlatform.WindowsEditor: target = BuildTarget.StandaloneWindows64; output = "Build/Coins.exe"; break;
            case RuntimePlatform.OSXEditor: target = BuildTarget.StandaloneOSX; output = "Build/Coins.app"; break;
            default: target = BuildTarget.StandaloneLinux64; output = "Build/Coins.x86_64"; break;
        }
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = output,
            target = target,
            options = BuildOptions.None,
        });
        if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
        {
            Debug.LogError("Coins build failed: " + report.summary.result);
            EditorApplication.Exit(1);
        }
    }
}
